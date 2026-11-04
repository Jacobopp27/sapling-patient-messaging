// The hosted demo (Vercel + Neon): every API request loads the thread into a MemoryStore, runs the
// agent and writes back what changed. These tests check that this gives the same conversation as
// the local SQLite store, across "restarts", and that the HTTP API behaves the same on both.
// The Postgres tests run when TEST_DATABASE_URL points at a disposable database.
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { ruleInterpreter } from '../server/agent/ruleInterpreter';
import { createApp } from '../server/app';
import { loadClinicData } from '../server/data';
import { MemoryStore, type StoreRows } from '../server/memoryStore';
import { postgresStore } from '../server/postgres';
import { SCRIPT } from '../server/script';
import { ConversationService } from '../server/service';
import { openService, tempDbFile } from './helpers';

const pid = 'pt_001';
const data = loadClinicData();
const service = (store: MemoryStore) => new ConversationService(store, data, ruleInterpreter);

/** What a reviewer reads: who said what, and what was filed. Timestamps aside. */
function transcript(messages: { author: string; body: string }[], requests: { type: string; status: string; details: unknown; sourceMessageIds: number[] }[]) {
  return {
    messages: messages.map((m) => `${m.author}: ${m.body}`),
    requests: requests.map((r) => ({ type: r.type, status: r.status, details: r.details, sources: r.sourceMessageIds })),
  };
}

async function playScript(send: (author: 'clinic' | 'patient', body: string) => Promise<void>) {
  for (const s of SCRIPT) await send(s.author, s.body);
}

describe('per-request snapshot store (what the hosted demo does)', () => {
  it('plays the whole script exactly like the SQLite store, one fresh store per message', async () => {
    const local = openService(tempDbFile());
    await playScript(async (author, body) => {
      if (author === 'clinic') local.sendClinicMessage(body);
      else await local.receivePatientMessage(body);
    });

    let rows: StoreRows = { messages: [], requests: [], settings: {} };
    await playScript(async (author, body) => {
      const store = new MemoryStore(rows); // a new serverless invocation
      const svc = service(store);
      if (author === 'clinic') svc.sendClinicMessage(body);
      else await svc.receivePatientMessage(body);
      rows = store.rows();
    });

    expect(transcript(rows.messages, rows.requests)).toEqual(transcript(local.store.listMessages(pid), local.store.listRequests(pid)));
  });

  it('reports only what changed, and a reset as a reset', () => {
    const store = new MemoryStore();
    const first = store.addMessage({ patientId: pid, author: 'clinic', body: 'hi', fromNumber: 'a', toNumber: 'b' });
    const req = store.createRequest({ patientId: pid, type: 'refill', details: { medication: 'Lisinopril' }, sourceMessageIds: [first.id] });
    const next = new MemoryStore(store.rows());
    next.updateRequest(req.id, { status: 'completed' });
    const c = next.changes();
    expect(c).toMatchObject({ reset: false, newMessages: [], newRequests: [], settings: {} });
    expect(c.updatedRequests.map((r) => [r.id, r.status])).toEqual([[req.id, 'completed']]);

    next.reset();
    next.addMessage({ patientId: pid, author: 'patient', body: 'again', fromNumber: 'b', toNumber: 'a' });
    expect(next.changes()).toMatchObject({ reset: true, updatedRequests: [], newMessages: [{ id: 1, body: 'again' }] });
  });
});

describe('HTTP API', () => {
  const servers: { close(): void }[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  async function serve() {
    const svc = openService(tempDbFile());
    const server = createApp((fn) => fn(svc)).listen(0);
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const call = (method: string, path: string, body?: unknown) =>
      fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return call;
  }

  it('answers a patient message and returns the new state', async () => {
    const call = await serve();
    const res = await call('POST', '/messages', { author: 'patient', body: 'what time do you close today?' });
    const state = await res.json();
    expect(res.status).toBe(200);
    expect(state.messages.map((m: { author: string }) => m.author)).toEqual(['patient', 'agent']);
    expect(state.sharedDemo).toBe(false);
  });

  it('rejects bad input with a 400 and an unknown request with a 404', async () => {
    const call = await serve();
    expect((await call('POST', '/messages', { author: 'doctor', body: 'hi' })).status).toBe(400);
    expect((await call('PATCH', '/settings', { now: 'tomorrow-ish' })).status).toBe(400);
    expect((await call('PATCH', '/requests/99', { status: 'completed' })).status).toBe(404);
  });
});

const PG = process.env.TEST_DATABASE_URL;

describe.skipIf(!PG)('Postgres (TEST_DATABASE_URL)', () => {
  it('plays the script one transaction per message, survives a restart, and keeps one of each request', async () => {
    let db = postgresStore(PG!);
    await db.run(async (store) => store.reset());
    const steps = SCRIPT.slice(0, 12);
    for (const s of steps) {
      await db.run(async (store) => {
        const svc = service(store);
        if (s.author === 'clinic') svc.sendClinicMessage(s.body);
        else await svc.receivePatientMessage(s.body);
      });
    }
    await db.close();
    db = postgresStore(PG!); // the restart: a new pool, nothing kept in memory

    const reply = await db.run(async (store) => (await service(store).receivePatientMessage(SCRIPT[12].body)).reply);
    const lines = reply.body.split('\n');
    expect(lines[1]).toBe('1) A BP recheck with Dr. Priya Lee on Thursday, Nov 12, in the afternoon (a request, not booked yet)');
    expect(lines[2]).toBe('2) A refill of Lisinopril 10 mg, once daily, at Elm Street Pharmacy');
    expect(lines[3]).toBe('3) Your question for a clinician about your readings (around 150/95)');

    const types = await db.run(async (store) => store.listRequests(pid).map((r) => r.type));
    expect(types).toEqual(['appointment_request', 'refill', 'clinical_question', 'emergency']);
    await db.close();
  });

  it('serialises two messages sent at the same moment (no lost or duplicate rows)', async () => {
    const db1 = postgresStore(PG!);
    const db2 = postgresStore(PG!); // two serverless instances
    await db1.run(async (store) => store.reset());
    await Promise.all([
      db1.run(async (store) => { await service(store).receivePatientMessage('can I get a refill on my BP med'); }),
      db2.run(async (store) => { await service(store).receivePatientMessage('can I get a refill on my BP med'); }),
    ]);
    const { messages, requests } = await db1.run(async (store) => ({ messages: store.listMessages(pid), requests: store.listRequests(pid) }));
    expect(messages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(requests.map((r) => r.type)).toEqual(['refill']); // the second message updated the first refill
    await Promise.all([db1.close(), db2.close()]);
  });
});

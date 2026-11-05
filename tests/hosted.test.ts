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
import { resolveRequest } from '../server/resolutions';
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
    const server = createApp((_thread, fn) => fn(svc)).listen(0);
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
    expect(state.hosted).toBe(false);
  });

  it('rejects bad input with a 400 and an unknown request with a 404', async () => {
    const call = await serve();
    expect((await call('POST', '/messages', { author: 'doctor', body: 'hi' })).status).toBe(400);
    expect((await call('PATCH', '/settings', { now: 'tomorrow-ish' })).status).toBe(400);
    expect((await call('PATCH', '/requests/99', { status: 'completed' })).status).toBe(404);
  });

  describe('voice calls', () => {
    // Only the presence of OPENAI_API_KEY is checked here; nothing in these tests calls OpenAI.
    const saved = process.env.OPENAI_API_KEY;
    afterAll(() => { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; });

    it('a call is greeted, keeps what the clinic was waiting for, and its replies stay on the call', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      const call = await serve();
      await call('POST', '/messages', { author: 'clinic', body: SCRIPT[0].body });
      const started = await (await call('POST', '/voice/start', { callId: 'call-abc123' })).json();
      expect(started.voiceAvailable).toBe(true);
      const greeting = started.messages.at(-1);
      expect(greeting).toMatchObject({ author: 'agent', meta: { channel: 'voice', callId: 'call-abc123' } });
      expect(greeting.body).toMatch(/automated assistant/);
      expect(greeting.meta.pending).toEqual(started.messages[0].meta.pending); // the clinic's offer is still open

      const state = await (await call('POST', '/messages', { author: 'patient', body: 'Tuesday afternoon works', callId: 'call-abc123' })).json();
      const [said, reply] = state.messages.slice(-2);
      expect(said.meta).toMatchObject({ channel: 'voice', callId: 'call-abc123' });
      expect(reply.meta).toMatchObject({ channel: 'voice', callId: 'call-abc123' });
      expect(state.requests[0].details).toMatchObject({ reason: 'BP recheck', date: '2026-11-10' });
    });

    it('rejects a bad call id, speaks only the clinic\'s own messages, and is off without a key', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      const call = await serve();
      expect((await call('POST', '/voice/start', {})).status).toBe(400);
      expect((await call('POST', '/messages', { author: 'patient', body: 'hi', callId: 'x' })).status).toBe(400);
      expect((await call('POST', '/messages', { author: 'clinic', body: 'hi', callId: 'call-abc123' })).status).toBe(400);
      await call('POST', '/messages', { author: 'patient', body: 'hello' });
      expect((await call('GET', '/voice/speech/1')).status).toBe(404); // Alex's message: not ours to speak
      expect((await call('GET', '/voice/speech/99')).status).toBe(404);

      delete process.env.OPENAI_API_KEY;
      expect((await (await call('GET', '/state')).json()).voiceAvailable).toBe(false);
      expect((await call('POST', '/voice/token')).status).toBe(503);
      expect((await call('POST', '/voice/start', { callId: 'call-abc123' })).status).toBe(503);
    });
  });
});

const PG = process.env.TEST_DATABASE_URL;

describe.skipIf(!PG)('Postgres (TEST_DATABASE_URL)', () => {
  const T = 'test-thread-main';
  it('plays the script one transaction per message, survives a restart, and keeps one of each request', async () => {
    let db = postgresStore(PG!);
    await db.run(T, async (store) => store.reset());
    const steps = SCRIPT.slice(0, 12);
    for (const s of steps) {
      await db.run(T, async (store) => {
        const svc = service(store);
        if (s.author === 'clinic') svc.sendClinicMessage(s.body);
        else await svc.receivePatientMessage(s.body);
      });
    }
    await db.close();
    db = postgresStore(PG!); // the restart: a new pool, nothing kept in memory

    const reply = await db.run(T, async (store) => (await service(store).receivePatientMessage(SCRIPT[12].body)).reply);
    const lines = reply.body.split('\n');
    expect(lines[1]).toBe('1) A BP recheck with Dr. Priya Lee on Thursday, Nov 12, in the afternoon (a request, not booked yet)');
    expect(lines[2]).toBe('2) A refill of Lisinopril 10 mg, once daily, at Elm Street Pharmacy');
    expect(lines[3]).toBe('3) Your question for a clinician about your readings (around 150/95)');

    const types = await db.run(T, async (store) => store.listRequests(pid).map((r) => r.type));
    expect(types).toEqual(['appointment_request', 'refill', 'clinical_question', 'emergency']);
    await db.close();
  });

  it('keeps what staff resolved (booked for Thu 1:30) across a restart', async () => {
    let db = postgresStore(PG!);
    await db.run(T, async (store) => {
      store.reset();
      const svc = service(store);
      svc.sendClinicMessage(SCRIPT[0].body);
      await svc.receivePatientMessage('yes');
      await svc.receivePatientMessage('Thursday afternoon works');
      resolveRequest(svc, 1, { outcome: 'booked', date: '2026-11-12', time: '13:30', message: 'Booked for Thu 1:30.' });
    });
    await db.close();
    db = postgresStore(PG!);
    const reply = await db.run(T, async (store) => (await service(store).receivePatientMessage('is it booked yet?')).reply);
    expect(reply.body).toMatch(/Clinic staff booked your BP recheck .* Thursday, Nov 12 at 1:30 p\.m\./);
    await db.close();
  });

  it('serialises two messages sent at the same moment (no lost or duplicate rows)', async () => {
    const db1 = postgresStore(PG!);
    const db2 = postgresStore(PG!); // two serverless instances
    await db1.run(T, async (store) => store.reset());
    await Promise.all([
      db1.run(T, async (store) => { await service(store).receivePatientMessage('can I get a refill on my BP med'); }),
      db2.run(T, async (store) => { await service(store).receivePatientMessage('can I get a refill on my BP med'); }),
    ]);
    const { messages, requests } = await db1.run(T, async (store) => ({ messages: store.listMessages(pid), requests: store.listRequests(pid) }));
    expect(messages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(requests.map((r) => r.type)).toEqual(['refill']); // the second message updated the first refill
    await Promise.all([db1.close(), db2.close()]);
  });

  it('keeps each visitor in their own thread: separate messages, separate ids, reset only clears yours', async () => {
    const db = postgresStore(PG!);
    const javen = 'test-thread-javen', justin = 'test-thread-justin';
    await db.run(javen, async (store) => store.reset());
    await db.run(justin, async (store) => store.reset());
    await db.run(javen, async (store) => { await service(store).receivePatientMessage('what time do you close today?'); });
    await db.run(justin, async (store) => {
      const svc = service(store);
      svc.sendClinicMessage(SCRIPT[0].body);
      await svc.receivePatientMessage('yes');
      await svc.receivePatientMessage('Tuesday afternoon works');
    });
    const read = (thread: string) => db.run(thread, async (store) => ({ messages: store.listMessages(pid), requests: store.listRequests(pid) }));
    const [a, b] = [await read(javen), await read(justin)];
    expect(a.messages.map((m) => m.body)).toEqual(['what time do you close today?', expect.stringContaining('We close at 5:00 p.m.')]);
    expect(a.requests).toEqual([]);
    expect(b.messages.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]); // ids start at 1 in every thread
    expect(b.requests.map((r) => r.type)).toEqual(['appointment_request']);

    await db.run(javen, async (store) => store.reset());
    expect((await read(javen)).messages).toEqual([]);
    expect((await read(justin)).messages).toHaveLength(5);
    await db.close();
  });
});

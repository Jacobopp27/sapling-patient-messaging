// Postgres persistence for the hosted demo (Vercel + Neon), where there is no disk that survives.
// Every visitor has their own thread (a random id their browser keeps), and every row carries it.
// Each API request runs as one transaction on that thread: take the thread's lock, load it into a
// MemoryStore, let the agent work on it exactly as it does locally, write back what changed, commit.
// The lock serialises requests on one thread across serverless instances, so two quick messages
// can't race on the same request; different visitors never wait for each other.
import pg from 'pg';
import { MemoryStore, type StoreChanges } from './memoryStore.js';
import type { Message, Request } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_messages (
  thread_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  patient_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  author TEXT NOT NULL CHECK (author IN ('clinic','patient','agent')),
  body TEXT NOT NULL,
  from_number TEXT,
  to_number TEXT,
  in_reply_to INTEGER,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, id)
);
CREATE TABLE IF NOT EXISTS thread_requests (
  thread_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  patient_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_staff',
  details JSONB NOT NULL,
  source_message_ids JSONB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolution JSONB,
  PRIMARY KEY (thread_id, id)
);
CREATE TABLE IF NOT EXISTS thread_settings (
  thread_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (thread_id, key)
);
`;

type Row = Record<string, any>;

const toMessage = (r: Row): Message => ({
  id: r.id, patientId: r.patient_id, direction: r.direction, author: r.author, body: r.body,
  fromNumber: r.from_number, toNumber: r.to_number, inReplyTo: r.in_reply_to, meta: r.meta, createdAt: r.created_at,
});

const toRequest = (r: Row): Request => ({
  id: r.id, patientId: r.patient_id, type: r.type, status: r.status, details: r.details,
  sourceMessageIds: r.source_message_ids, createdAt: r.created_at, updatedAt: r.updated_at, resolution: r.resolution ?? null,
});

async function save(db: pg.PoolClient, thread: string, c: StoreChanges) {
  if (c.reset) {
    for (const table of ['thread_messages', 'thread_requests', 'thread_settings']) {
      await db.query(`DELETE FROM ${table} WHERE thread_id = $1`, [thread]);
    }
  }
  for (const [key, value] of Object.entries(c.settings)) {
    await db.query(
      'INSERT INTO thread_settings (thread_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (thread_id, key) DO UPDATE SET value = EXCLUDED.value',
      [thread, key, value],
    );
  }
  for (const m of c.newMessages) {
    await db.query(
      'INSERT INTO thread_messages (thread_id, id, patient_id, direction, author, body, from_number, to_number, in_reply_to, meta, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
      [thread, m.id, m.patientId, m.direction, m.author, m.body, m.fromNumber, m.toNumber, m.inReplyTo, JSON.stringify(m.meta), m.createdAt],
    );
  }
  for (const r of c.newRequests) {
    await db.query(
      'INSERT INTO thread_requests (thread_id, id, patient_id, type, status, details, source_message_ids, created_at, updated_at, resolution) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [thread, r.id, r.patientId, r.type, r.status, JSON.stringify(r.details), JSON.stringify(r.sourceMessageIds), r.createdAt, r.updatedAt, r.resolution && JSON.stringify(r.resolution)],
    );
  }
  for (const r of c.updatedRequests) {
    await db.query(
      'UPDATE thread_requests SET status = $3, details = $4, source_message_ids = $5, updated_at = $6, resolution = $7 WHERE thread_id = $1 AND id = $2',
      [thread, r.id, r.status, JSON.stringify(r.details), JSON.stringify(r.sourceMessageIds), r.updatedAt, r.resolution && JSON.stringify(r.resolution)],
    );
  }
}

export interface PostgresStore {
  /** Run `fn` against one visitor's thread as one locked transaction; what it changed is saved on success. */
  run<T>(thread: string, fn: (store: MemoryStore) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function postgresStore(connectionString: string): PostgresStore {
  const pool = new pg.Pool({ connectionString, max: 3 });
  let schema: Promise<unknown> | undefined;

  return {
    async run(thread, fn) {
      schema ??= pool.query(SCHEMA).catch((err) => { schema = undefined; throw err; });
      await schema;
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`thread:${thread}`]);
        const [messages, requests, settings] = [
          (await db.query('SELECT * FROM thread_messages WHERE thread_id = $1 ORDER BY id', [thread])).rows.map(toMessage),
          (await db.query('SELECT * FROM thread_requests WHERE thread_id = $1 ORDER BY id', [thread])).rows.map(toRequest),
          Object.fromEntries((await db.query('SELECT key, value FROM thread_settings WHERE thread_id = $1', [thread])).rows.map((r) => [r.key, r.value])),
        ];
        const store = new MemoryStore({ messages, requests, settings });
        const result = await fn(store);
        await save(db, thread, store.changes());
        await db.query('COMMIT');
        return result;
      } catch (err) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        db.release();
      }
    },
    close: () => pool.end(),
  };
}

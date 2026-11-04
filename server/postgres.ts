// Postgres persistence for the hosted demo (Vercel + Neon), where there is no disk that survives.
// Each API request runs as one transaction: take a lock, load the thread into a MemoryStore, let the
// agent work on it exactly as it does locally, write back what changed, commit. The lock serialises
// requests across serverless instances, so two quick messages can't race on the same request.
import pg from 'pg';
import { MemoryStore, type StoreChanges } from './memoryStore.js';
import type { Message, Request } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  patient_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  author TEXT NOT NULL CHECK (author IN ('clinic','patient','agent')),
  body TEXT NOT NULL,
  from_number TEXT,
  to_number TEXT,
  in_reply_to INTEGER,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  patient_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_staff',
  details JSONB NOT NULL,
  source_message_ids JSONB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Any fixed number: the one demo thread is locked as a whole. */
const THREAD_LOCK = 4_242;

type Row = Record<string, any>;

const toMessage = (r: Row): Message => ({
  id: r.id, patientId: r.patient_id, direction: r.direction, author: r.author, body: r.body,
  fromNumber: r.from_number, toNumber: r.to_number, inReplyTo: r.in_reply_to, meta: r.meta, createdAt: r.created_at,
});

const toRequest = (r: Row): Request => ({
  id: r.id, patientId: r.patient_id, type: r.type, status: r.status, details: r.details,
  sourceMessageIds: r.source_message_ids, createdAt: r.created_at, updatedAt: r.updated_at,
});

async function save(db: pg.PoolClient, c: StoreChanges) {
  if (c.reset) await db.query('DELETE FROM messages; DELETE FROM requests; DELETE FROM settings;');
  for (const [key, value] of Object.entries(c.settings)) {
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  }
  for (const m of c.newMessages) {
    await db.query(
      'INSERT INTO messages (id, patient_id, direction, author, body, from_number, to_number, in_reply_to, meta, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [m.id, m.patientId, m.direction, m.author, m.body, m.fromNumber, m.toNumber, m.inReplyTo, JSON.stringify(m.meta), m.createdAt],
    );
  }
  for (const r of c.newRequests) {
    await db.query(
      'INSERT INTO requests (id, patient_id, type, status, details, source_message_ids, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [r.id, r.patientId, r.type, r.status, JSON.stringify(r.details), JSON.stringify(r.sourceMessageIds), r.createdAt, r.updatedAt],
    );
  }
  for (const r of c.updatedRequests) {
    await db.query(
      'UPDATE requests SET status = $2, details = $3, source_message_ids = $4, updated_at = $5 WHERE id = $1',
      [r.id, r.status, JSON.stringify(r.details), JSON.stringify(r.sourceMessageIds), r.updatedAt],
    );
  }
}

export interface PostgresStore {
  /** Run `fn` against the thread as one locked transaction; what it changed is saved on success. */
  run<T>(fn: (store: MemoryStore) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function postgresStore(connectionString: string): PostgresStore {
  const pool = new pg.Pool({ connectionString, max: 3 });
  let schema: Promise<unknown> | undefined;

  return {
    async run(fn) {
      schema ??= pool.query(SCHEMA).catch((err) => { schema = undefined; throw err; });
      await schema;
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('SELECT pg_advisory_xact_lock($1)', [THREAD_LOCK]);
        const [messages, requests, settings] = [
          (await db.query('SELECT * FROM messages ORDER BY id')).rows.map(toMessage),
          (await db.query('SELECT * FROM requests ORDER BY id')).rows.map(toRequest),
          Object.fromEntries((await db.query('SELECT key, value FROM settings')).rows.map((r) => [r.key, r.value])),
        ];
        const store = new MemoryStore({ messages, requests, settings });
        const result = await fn(store);
        await save(db, store.changes());
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

// SQLite persistence: messages, requests (handoffs) and settings. The only mutable state in the app.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_NOW } from './clock';
import { OPEN_STATUSES, type Details, type RequestStatus, type RequestType } from './requests';
import type { Author, Message, MessageMeta, Request, Settings } from './types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  author TEXT NOT NULL CHECK (author IN ('clinic','patient','agent')),
  body TEXT NOT NULL,
  from_number TEXT,
  to_number TEXT,
  in_reply_to INTEGER REFERENCES messages(id),
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_staff',
  details TEXT NOT NULL,
  source_message_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type Row = Record<string, any>;

const toMessage = (r: Row): Message => ({
  id: r.id, patientId: r.patient_id, direction: r.direction, author: r.author, body: r.body,
  fromNumber: r.from_number, toNumber: r.to_number,
  inReplyTo: r.in_reply_to, meta: JSON.parse(r.meta), createdAt: r.created_at,
});

const toRequest = (r: Row): Request => ({
  id: r.id, patientId: r.patient_id, type: r.type, status: r.status, details: JSON.parse(r.details),
  sourceMessageIds: JSON.parse(r.source_message_ids), createdAt: r.created_at, updatedAt: r.updated_at,
});

export class Store {
  private db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    // Databases created before the phone columns existed.
    const cols = (this.db.prepare('PRAGMA table_info(messages)').all() as Row[]).map((c) => c.name);
    for (const c of ['from_number', 'to_number']) if (!cols.includes(c)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${c} TEXT`);
    if (!this.setting('clockSetAt')) this.updateSettings({ now: this.getSettings().now });
  }

  close() { this.db.close(); }

  reset() {
    this.db.exec('DELETE FROM messages; DELETE FROM requests; DELETE FROM settings; DELETE FROM sqlite_sequence;');
  }

  // --- settings ---
  private setting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined)?.value;
  }

  getSettings(): Settings {
    return { now: this.setting('now') ?? DEFAULT_NOW, agentMode: this.setting('agentMode') === 'claude' ? 'claude' : 'local' };
  }

  /** Setting `now` also restarts the scenario clock from that moment. */
  updateSettings(patch: Partial<Settings>) {
    const stmt = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) stmt.run(k, String(v));
    if (patch.now !== undefined) stmt.run('clockSetAt', String(Date.now()));
  }

  /**
   * The scenario clock: the configured `now` plus the real time elapsed since it was set. It keeps
   * running across restarts, so a request updated later gets a later updated_at than created_at.
   */
  now(): string {
    const elapsed = Math.max(0, Date.now() - Number(this.setting('clockSetAt') ?? Date.now()));
    return new Date(Date.parse(this.getSettings().now) + elapsed).toISOString();
  }

  // --- messages ---
  addMessage(m: {
    patientId: string; author: Author; body: string; fromNumber: string; toNumber: string; inReplyTo?: number | null; meta?: MessageMeta;
  }): Message {
    const direction = m.author === 'patient' ? 'inbound' : 'outbound';
    const info = this.db.prepare(
      'INSERT INTO messages (patient_id, direction, author, body, from_number, to_number, in_reply_to, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(m.patientId, direction, m.author, m.body, m.fromNumber, m.toNumber, m.inReplyTo ?? null, JSON.stringify(m.meta ?? {}), this.now());
    return this.getMessage(Number(info.lastInsertRowid))!;
  }

  getMessage(id: number): Message | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r && toMessage(r);
  }

  listMessages(patientId: string): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE patient_id = ? ORDER BY id').all(patientId) as Row[]).map(toMessage);
  }

  lastOutbound(patientId: string): Message | undefined {
    const r = this.db.prepare("SELECT * FROM messages WHERE patient_id = ? AND direction = 'outbound' ORDER BY id DESC LIMIT 1").get(patientId) as Row | undefined;
    return r && toMessage(r);
  }

  // --- requests ---
  createRequest(r: { patientId: string; type: RequestType; details: Details; sourceMessageIds: number[] }): Request {
    const now = this.now();
    const info = this.db.prepare(
      'INSERT INTO requests (patient_id, type, status, details, source_message_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(r.patientId, r.type, 'pending_staff', JSON.stringify(r.details), JSON.stringify(r.sourceMessageIds), now, now);
    return this.getRequest(Number(info.lastInsertRowid))!;
  }

  updateRequest(id: number, patch: { details?: Details; sourceMessageIds?: number[]; status?: RequestStatus }): Request {
    const current = this.getRequest(id);
    if (!current) throw new Error(`request ${id} not found`);
    this.db.prepare('UPDATE requests SET details = ?, source_message_ids = ?, status = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(patch.details ?? current.details),
      JSON.stringify(patch.sourceMessageIds ?? current.sourceMessageIds),
      patch.status ?? current.status,
      this.now(),
      id,
    );
    return this.getRequest(id)!;
  }

  getRequest(id: number): Request | undefined {
    const r = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Row | undefined;
    return r && toRequest(r);
  }

  listRequests(patientId: string): Request[] {
    return (this.db.prepare('SELECT * FROM requests WHERE patient_id = ? ORDER BY id').all(patientId) as Row[]).map(toRequest);
  }

  openRequests(patientId: string, type?: RequestType): Request[] {
    return this.listRequests(patientId).filter((r) => OPEN_STATUSES.includes(r.status) && (!type || r.type === type));
  }
}

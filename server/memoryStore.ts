// The thread held in memory for one request on the hosted demo. postgres.ts loads every row into it
// (one patient, a short thread), the agent runs against it exactly as it does against SQLite, and
// `changes()` says what to write back in the same transaction.
import { DEFAULT_NOW, runningClock } from './clock.js';
import { OPEN_STATUSES, type Details, type RequestType } from './requests.js';
import type { DataStore, Message, NewMessage, Request, RequestPatch, Settings } from './types.js';

export interface StoreRows { messages: Message[]; requests: Request[]; settings: Record<string, string> }

export interface StoreChanges {
  /** Everything was deleted first (the demo's Reset). */
  reset: boolean;
  settings: Record<string, string>;
  newMessages: Message[];
  newRequests: Request[];
  updatedRequests: Request[];
}

const copy = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements DataStore {
  private messages: Message[];
  private requests: Request[];
  private settings: Record<string, string>;
  private wasReset = false;
  private touched = { settings: new Set<string>(), messages: new Set<number>(), created: new Set<number>(), updated: new Set<number>() };

  constructor(rows: StoreRows = { messages: [], requests: [], settings: {} }) {
    this.messages = copy(rows.messages);
    this.requests = copy(rows.requests);
    this.settings = { ...rows.settings };
    if (!this.settings.clockSetAt) this.updateSettings({ now: this.getSettings().now });
  }

  /** The rows as they would be stored now. */
  rows(): StoreRows {
    return copy({ messages: this.messages, requests: this.requests, settings: this.settings });
  }

  changes(): StoreChanges {
    const t = this.touched;
    return copy({
      reset: this.wasReset,
      settings: Object.fromEntries([...t.settings].map((k) => [k, this.settings[k]])),
      newMessages: this.messages.filter((m) => t.messages.has(m.id)),
      newRequests: this.requests.filter((r) => t.created.has(r.id)),
      updatedRequests: this.requests.filter((r) => t.updated.has(r.id) && !t.created.has(r.id)),
    });
  }

  close() {}

  reset() {
    this.messages = [];
    this.requests = [];
    this.settings = {};
    this.wasReset = true;
    Object.values(this.touched).forEach((set) => set.clear());
  }

  // --- settings ---
  getSettings(): Settings {
    return { now: this.settings.now ?? DEFAULT_NOW, agentMode: this.settings.agentMode === 'claude' ? 'claude' : 'local' };
  }

  updateSettings(patch: Partial<Settings>) {
    const set = (k: string, v: string) => { this.settings[k] = v; this.touched.settings.add(k); };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) set(k, String(v));
    if (patch.now !== undefined) set('clockSetAt', String(Date.now()));
  }

  now(): string {
    return runningClock(this.getSettings().now, this.settings.clockSetAt);
  }

  // --- messages ---
  addMessage(m: NewMessage): Message {
    const message: Message = {
      id: Math.max(0, ...this.messages.map((x) => x.id)) + 1,
      patientId: m.patientId,
      direction: m.author === 'patient' ? 'inbound' : 'outbound',
      author: m.author,
      body: m.body,
      fromNumber: m.fromNumber,
      toNumber: m.toNumber,
      inReplyTo: m.inReplyTo ?? null,
      meta: copy(m.meta ?? {}),
      createdAt: this.now(),
    };
    this.messages.push(message);
    this.touched.messages.add(message.id);
    return copy(message);
  }

  getMessage(id: number): Message | undefined {
    const m = this.messages.find((x) => x.id === id);
    return m && copy(m);
  }

  listMessages(patientId: string): Message[] {
    return copy(this.messages.filter((m) => m.patientId === patientId).sort((a, b) => a.id - b.id));
  }

  lastOutbound(patientId: string): Message | undefined {
    return this.listMessages(patientId).filter((m) => m.direction === 'outbound').at(-1);
  }

  // --- requests ---
  createRequest(r: { patientId: string; type: RequestType; details: Details; sourceMessageIds: number[] }): Request {
    const now = this.now();
    const request: Request = {
      id: Math.max(0, ...this.requests.map((x) => x.id)) + 1,
      patientId: r.patientId,
      type: r.type,
      status: 'pending_staff',
      details: copy(r.details),
      sourceMessageIds: [...r.sourceMessageIds],
      createdAt: now,
      updatedAt: now,
      resolution: null,
    };
    this.requests.push(request);
    this.touched.created.add(request.id);
    return copy(request);
  }

  updateRequest(id: number, patch: RequestPatch): Request {
    const current = this.requests.find((x) => x.id === id);
    if (!current) throw new Error(`request ${id} not found`);
    if (patch.details) current.details = copy(patch.details);
    if (patch.sourceMessageIds) current.sourceMessageIds = [...patch.sourceMessageIds];
    if (patch.status) current.status = patch.status;
    if (patch.resolution) current.resolution = copy(patch.resolution);
    current.updatedAt = this.now();
    this.touched.updated.add(id);
    return copy(current);
  }

  getRequest(id: number): Request | undefined {
    const r = this.requests.find((x) => x.id === id);
    return r && copy(r);
  }

  listRequests(patientId: string): Request[] {
    return copy(this.requests.filter((r) => r.patientId === patientId).sort((a, b) => a.id - b.id));
  }

  openRequests(patientId: string, type?: RequestType): Request[] {
    return this.listRequests(patientId).filter((r) => OPEN_STATUSES.includes(r.status) && (!type || r.type === type));
  }
}

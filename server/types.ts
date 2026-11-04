// Shared shapes for the store, the agent and the UI (web/ imports these as types only).
import type { Details, RequestStatus, RequestType } from './requests';

export type Author = 'clinic' | 'patient' | 'agent';

/** Where an agent reply's content came from. Drives the chip under each reply in the UI. */
export type ReplySource =
  | 'record' | 'faq' | 'open_slots' | 'requests' | 'staff_handoff'
  | 'emergency_rule' | 'not_available' | 'clarifying' | 'general';

/**
 * What the last outbound message is waiting for, so a short reply like "yes" or "Tuesday afternoon"
 * can be matched to it. Stored on the outbound message, so it survives a restart.
 */
export type Pending =
  | { kind: 'appointment_offer'; reason: string; provider: string; context?: string }
  | { kind: 'appointment_time'; reason: string; provider: string; context?: string; sourceMessageIds?: number[] }
  | { kind: 'appointment_reason'; date?: string; window?: string; time?: string }
  | { kind: 'pass_to_staff'; question: string; topic: string; messageId: number }
  /** "Which one do you mean?" when Alex asks to change an appointment and has both kinds. */
  | { kind: 'change_target'; action: 'reschedule' | 'cancel'; date?: string; window?: string; time?: string }
  /** Waiting for a new day for a booked appointment (follow-ups update that change request). */
  | { kind: 'reschedule_time'; appointment: string };

export interface RequestEvent { requestId: number; action: 'created' | 'updated' }

export interface Trace {
  interpreter: 'rules' | 'claude' | 'none';
  interpretation?: unknown;
  tools: string[];
  guards: { emergency: 'clear' | string; reply: 'ok' | string };
  note?: string;
}

export interface MessageMeta {
  /** True when the sender swiped to reply to a specific message (shown as a quote in the UI). */
  explicitReply?: boolean;
  source?: ReplySource;
  pending?: Pending;
  requestEvents?: RequestEvent[];
  trace?: Trace;
}

export interface Message {
  id: number;
  patientId: string;
  direction: 'inbound' | 'outbound';
  author: Author;
  body: string;
  /** Simulated SMS metadata: Alex's number on file and the clinic's number from the FAQ. */
  fromNumber: string | null;
  toNumber: string | null;
  inReplyTo: number | null;
  meta: MessageMeta;
  createdAt: string;
}

export interface Request {
  id: number;
  patientId: string;
  type: RequestType;
  status: RequestStatus;
  details: Details;
  sourceMessageIds: number[];
  createdAt: string;
  updatedAt: string;
}

export interface Settings { now: string; agentMode: 'local' | 'claude' }

export interface NewMessage {
  patientId: string; author: Author; body: string; fromNumber: string; toNumber: string; inReplyTo?: number | null; meta?: MessageMeta;
}

/**
 * What the agent, the service and the API need from storage. SQLite (`Store`) implements it for the
 * local demo; `MemoryStore` implements it for one request at a time on the hosted (Postgres) demo.
 */
export interface DataStore {
  getSettings(): Settings;
  /** Setting `now` also restarts the scenario clock from that moment. */
  updateSettings(patch: Partial<Settings>): void;
  /** The scenario clock right now (see `runningClock`). */
  now(): string;
  addMessage(m: NewMessage): Message;
  getMessage(id: number): Message | undefined;
  listMessages(patientId: string): Message[];
  lastOutbound(patientId: string): Message | undefined;
  createRequest(r: { patientId: string; type: RequestType; details: Details; sourceMessageIds: number[] }): Request;
  updateRequest(id: number, patch: { details?: Details; sourceMessageIds?: number[]; status?: RequestStatus }): Request;
  getRequest(id: number): Request | undefined;
  listRequests(patientId: string): Request[];
  openRequests(patientId: string, type?: RequestType): Request[];
  reset(): void;
  close(): void;
}

// Closing the loop with staff. When staff close a request they record what happened (booked for
// Thu 1:30, refill approved, ...). That record is the source of truth the agent reports back to Alex;
// the agent itself still can't book, approve or cancel anything. Pure functions plus one staff
// action, so the UI can share the outcome list and the draft text.
import { formatDate, formatTime } from './clock.js';
import type { RequestType } from './requests.js';
import type { ConversationService } from './service.js';
import type { Request, Resolution } from './types.js';

type Outcome = Resolution['outcome'];

/** The outcomes staff can pick for each request type, first one is the default. */
export const OUTCOMES: Record<RequestType, Outcome[]> = {
  appointment_request: ['booked', 'not_booked'],
  appointment_change: ['done', 'not_done'],
  refill: ['approved', 'denied'],
  clinical_question: ['answered'],
  billing: ['answered'],
  other: ['answered'],
  outreach_declined: ['done'],
  emergency: ['done'],
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  booked: 'Booked',
  not_booked: "Couldn't book",
  approved: 'Approved',
  denied: 'Not approved',
  done: 'Done',
  not_done: "Couldn't do it",
  answered: 'Replied to Alex',
};

/** Outcomes that need a date and time: a booked visit, or a booked appointment moved. */
export function needsAppointment(r: Request, outcome: Outcome): boolean {
  return outcome === 'booked' || (r.type === 'appointment_change' && r.details.action === 'reschedule' && outcome === 'done');
}

/** Staff's first draft of the text to Alex. Staff edit it before sending; it's their message. */
export function draftUpdate(r: Request, outcome: Outcome, appointment?: { date: string; time: string; provider: string }): string {
  const d = r.details;
  const when = appointment ? `${formatDate(appointment.date)} at ${formatTime(appointment.time)}` : '';
  /** "…at 1:30 p.m." already ends the sentence. */
  const at = (text: string) => (text.endsWith('.') ? text : `${text}.`);
  const sign = ' – Sapling Family Clinic';
  switch (`${r.type}:${outcome}`) {
    case 'appointment_request:booked':
      return `Hi Alex, your ${d.reason} with ${appointment?.provider ?? d.provider} is booked for ${at(when)} Reply here if you need to change it.${sign}`;
    case 'appointment_request:not_booked':
      return `Hi Alex, we weren't able to book your ${d.reason} for the time you asked. Reply here with another day that works for you.${sign}`;
    case 'appointment_change:done':
      return d.action === 'cancel'
        ? `Hi Alex, your ${String(d.type).toLowerCase()} on ${formatDate(String(d.current_date))} has been cancelled.${sign}`
        : `Hi Alex, your ${String(d.type).toLowerCase()} has been moved to ${at(when)}${sign}`;
    case 'appointment_change:not_done':
      return `Hi Alex, we couldn't make that change to your ${String(d.type).toLowerCase()}. Please call the clinic during business hours.${sign}`;
    case 'refill:approved':
      return `Hi Alex, your ${d.medication} refill was approved and sent to ${String(d.pharmacy).split(',')[0]}.${sign}`;
    case 'refill:denied':
      return `Hi Alex, we couldn't approve your ${d.medication} refill by text. Please call the clinic during business hours so we can help.${sign}`;
    case 'emergency:done':
    case 'outreach_declined:done':
      return '';
    default:
      return 'Hi Alex, ';
  }
}

export class ResolveError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface ResolveInput {
  outcome?: string;
  date?: string;
  time?: string;
  provider?: string;
  note?: string;
  /** Optional text to Alex, sent as a clinic message (staff's words, not the agent's). */
  message?: string;
}

/** The staff action: record the outcome, close the request and optionally text Alex. */
export function resolveRequest(service: ConversationService, id: number, input: ResolveInput): Request {
  const { store } = service;
  const r = store.getRequest(id);
  if (!r) throw new ResolveError(404, 'not found');
  if (r.resolution) throw new ResolveError(409, 'this request is already resolved');
  const outcome = input.outcome as Outcome;
  if (!OUTCOMES[r.type].includes(outcome)) {
    throw new ResolveError(400, `outcome for ${r.type} must be one of ${OUTCOMES[r.type].join(', ')}`);
  }
  let appointment: Resolution['appointment'];
  if (needsAppointment(r, outcome)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '') || Number.isNaN(Date.parse(String(input.date)))) throw new ResolveError(400, 'date must be YYYY-MM-DD');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time ?? '')) throw new ResolveError(400, 'time must be HH:MM (24h)');
    const provider = input.provider?.trim() || String(r.details.provider ?? '');
    if (!provider) throw new ResolveError(400, 'provider is required');
    appointment = { date: input.date!, time: input.time!, provider };
  }
  const resolution: Resolution = {
    outcome,
    ...(appointment ? { appointment } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    resolvedAt: store.now(),
  };
  const updated = store.updateRequest(id, { status: 'completed', resolution });
  if (input.message?.trim()) service.sendClinicMessage(input.message.trim());
  return updated;
}

// The contract between "understanding" and "deciding". An interpreter (rules or Claude) turns
// Alex's text into this shape; handlers in code decide what to do with it.

export const INTENTS = [
  'affirm',                 // "yes", "sure": answers whatever the last outbound message asked
  'decline',                // "no thanks"
  'appointment_preference', // wants a visit / gives or changes day, window or time
  'appointment_status',     // "is it booked yet?"
  'next_appointment',       // "when is my next appointment?"
  'change_appointment',     // move or cancel an appointment ("can we move my physical?", "cancel the recheck")
  'clinic_info',            // a question the FAQ answers (topic = FAQ key)
  'record_info',            // a question about Alex's own record (topic = provider | medications | pharmacy | insurance)
  'not_in_data',            // a policy question the supplied data can't answer (e.g. insurance accepted)
  'refill',                 // medication refill
  'clinical_question',      // symptoms, readings, dosing, "should I...": never answered, always handed off
  'balance',                // "why do I owe $40?"
  'billing_issue',          // disputes, payment plans: handed off
  'list_requests',          // "what have I asked you for?"
  'thanks',
  'unknown',
] as const;
export type Intent = (typeof INTENTS)[number];

export const RECORD_TOPICS = ['provider', 'medications', 'pharmacy', 'insurance'] as const;

export const FAQ_TOPICS = ['hours', 'address', 'phone', 'texting', 'paying a balance', 'what to bring', 'cancellations'] as const;

export interface Interpretation {
  intent: Intent;
  /** Weekday name, lowercase ("thursday"). */
  weekday?: string;
  /** Explicit calendar date, YYYY-MM-DD. */
  date?: string;
  window?: 'morning' | 'afternoon';
  /** Specific time, HH:MM 24h. */
  time?: string;
  /** FAQ key for clinic_info; record field for record_info; short description for not_in_data. */
  topic?: string;
  medication?: string;
  /** Blood pressure or other readings quoted by the patient, e.g. "150/95". */
  readings?: string[];
  /** Time period the readings cover, e.g. "all week". */
  period?: string;
  /** A time ("I can't at 3:30") or day ("Tuesday doesn't work") Alex rules out. */
  avoid_time?: string;
  avoid_weekday?: string;
  /** For change_appointment. */
  action?: 'reschedule' | 'cancel';
  /** For change_appointment: the booked appointment on file, or the pending request. Unset if unclear. */
  target?: 'booked' | 'request';
  /** Other things the same message asks for. Only the main intent is handled; Alex is told about the rest. */
  also?: Intent[];
  /** Second, semantic emergency check (Claude mode only). */
  possible_emergency?: boolean;
}

export interface InterpreterContext {
  text: string;
  /** Recent thread, oldest first, as "author: body" lines. */
  thread: string[];
  /** What the last outbound message is waiting for, if anything. */
  pending?: string;
  today: string;
  medications: string[];
  /** Types of the booked appointments on file, e.g. "Annual physical". */
  appointmentTypes: string[];
}

export interface Interpreter {
  name: 'rules' | 'claude';
  interpret(ctx: InterpreterContext): Promise<Interpretation>;
}

// Request catalog: the one place that defines what each handoff type must contain for staff to act
// without texting Alex again. Adding a request type = one entry here (+ an intent that files it).

export type RequestType =
  | 'appointment_request' | 'appointment_change' | 'refill' | 'clinical_question' | 'billing'
  | 'outreach_declined' | 'other' | 'emergency';
export type RequestStatus = 'pending_staff' | 'in_progress' | 'completed' | 'cancelled';
export const OPEN_STATUSES: RequestStatus[] = ['pending_staff', 'in_progress'];

export type Details = Record<string, unknown>;

export interface RequestTypeSpec {
  label: string;
  /** Fields staff need to act. Missing ones show up as "needs follow-up" in the staff queue. */
  required: string[];
  /** Open requests of the same type with the same key are updated instead of duplicated. */
  dedupeKey?: (details: Details) => string;
}

export const REQUEST_TYPES: Record<RequestType, RequestTypeSpec> = {
  appointment_request: {
    label: 'Appointment request',
    required: ['reason', 'provider', 'date', 'window'],
    dedupeKey: (d) => String(d.reason),
  },
  // A change to an appointment that is already booked (the physical), kept apart from the
  // recheck request so "move my physical" can never edit the wrong record.
  appointment_change: {
    label: 'Change to a booked appointment',
    required: ['action', 'appointment'],
    dedupeKey: (d) => String(d.appointment),
  },
  refill: {
    label: 'Refill',
    required: ['medication', 'dose', 'frequency', 'pharmacy'],
    dedupeKey: (d) => String(d.medication),
  },
  clinical_question: { label: 'Clinical question', required: ['patient_question', 'summary'] },
  billing: { label: 'Billing', required: ['question'] },
  // The clinic offered a visit (e.g. Dr. Lee's BP recheck) and Alex said no: staff need to know.
  outreach_declined: { label: 'Declined outreach note', required: ['offer', 'patient_reply'], dedupeKey: (d) => String(d.offer) },
  other: { label: 'Other', required: ['question'] },
  emergency: { label: 'Emergency', required: ['message', 'signals'] },
};

export function missingFields(type: RequestType, details: Details): string[] {
  // Moving a booked appointment needs a new day; cancelling it doesn't.
  const required = type === 'appointment_change' && details.action === 'reschedule'
    ? [...REQUEST_TYPES[type].required, 'preferred_date', 'preferred_window']
    : REQUEST_TYPES[type].required;
  return required.filter((f) => {
    const v = details[f];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  });
}

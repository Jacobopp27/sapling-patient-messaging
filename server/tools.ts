// The agent's capabilities. Every read of supplied data and every write to the store goes through
// here, and each call is recorded for the "why" trace. There is deliberately no tool to book,
// cancel, approve or edit the record: the agent cannot do what it has no tool for.
import { inWindow, localNow, type DayWindow, type LocalNow } from './clock';
import type { ClinicData, Patient, Slot } from './data';
import { REQUEST_TYPES, type Details, type RequestType } from './requests';
import type { Store } from './store';
import type { Request, RequestEvent } from './types';

export class AgentTools {
  readonly calls: string[] = [];
  readonly events: RequestEvent[] = [];

  constructor(private store: Store, private data: ClinicData) {}

  private log(call: string) { this.calls.push(call); }

  now(): LocalNow {
    return localNow(this.store.now());
  }

  patient(field?: keyof Patient): Patient {
    this.log(field ? `record.${field}` : 'record');
    return this.data.patient;
  }

  faq(key: string): string | undefined {
    this.log(`faq.${key}`);
    return this.data.faq[key];
  }

  openSlots(filter: { date?: string; window?: DayWindow; provider?: string } = {}): Slot[] {
    this.log(`openSlots(${[filter.date, filter.window].filter(Boolean).join(', ')})`);
    return this.data.slots.filter((s) =>
      (!filter.date || s.date === filter.date)
      && (!filter.window || inWindow(s.start, filter.window))
      && (!filter.provider || s.provider === filter.provider)
      && s.date > this.now().date,
    );
  }

  openRequests(type?: RequestType): Request[] {
    this.log(`openRequests(${type ?? ''})`);
    return this.store.openRequests(this.data.patient.patient_id, type);
  }

  /** All of Alex's requests in any status, including ones staff closed. */
  requests(type?: RequestType): Request[] {
    this.log(`requests(${type ?? ''})`);
    return this.store.listRequests(this.data.patient.patient_id).filter((r) => !type || r.type === type);
  }

  /**
   * Create a pending_staff request, or update the open one of the same type and dedupe key.
   * This is what keeps "actually Thursday instead" from creating a second appointment request.
   */
  upsertRequest(type: RequestType, details: Details, sourceMessageIds: number[]): Request {
    const key = REQUEST_TYPES[type].dedupeKey;
    const existing = key && this.store.openRequests(this.data.patient.patient_id, type).find((r) => key(r.details) === key(details));
    if (existing) {
      this.log(`updateRequest(#${existing.id})`);
      const ids = [...new Set([...existing.sourceMessageIds, ...sourceMessageIds])];
      const updated = this.store.updateRequest(existing.id, { details: { ...existing.details, ...details }, sourceMessageIds: ids });
      this.events.push({ requestId: updated.id, action: 'updated' });
      return updated;
    }
    const created = this.store.createRequest({ patientId: this.data.patient.patient_id, type, details, sourceMessageIds });
    this.log(`createRequest(${type} #${created.id})`);
    this.events.push({ requestId: created.id, action: 'created' });
    return created;
  }
}

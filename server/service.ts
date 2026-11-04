// The conversation, as used by the HTTP API, the tests and the script runner.
import { runAgent } from './agent/agent.js';
import { claudeInterpreter, hasClaudeKey } from './agent/claudeInterpreter.js';
import type { Interpreter } from './agent/interpretation.js';
import { pendingFromClinicMessage } from './agent/outbound.js';
import { ruleInterpreter } from './agent/ruleInterpreter.js';
import type { ClinicData } from './data.js';

import type { DataStore, Message, Pending } from './types.js';

export class ConversationService {
  /** Messages are handled one at a time so two quick replies can't race on the same request. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly store: DataStore, readonly data: ClinicData, private interpreterOverride?: Interpreter) {}

  get patientId() { return this.data.patient.patient_id; }

  /** Simulated SMS numbers: Alex's phone on file and the clinic's number from the FAQ. */
  private get numbers() {
    return { patient: this.data.patient.phone, clinic: (this.data.faq.phone ?? 'clinic').split(',')[0] };
  }

  interpreter(): Interpreter {
    if (this.interpreterOverride) return this.interpreterOverride;
    return this.store.getSettings().agentMode === 'claude' && hasClaudeKey() ? claudeInterpreter : ruleInterpreter;
  }

  /** A message in this thread that a new message explicitly replies to (swipe-to-reply), if valid. */
  private quoted(replyTo?: number): Message | undefined {
    const m = replyTo === undefined ? undefined : this.store.getMessage(replyTo);
    return m?.patientId === this.patientId ? m : undefined;
  }

  /** Clinic outbound: saved and shown, never sent anywhere. */
  sendClinicMessage(body: string, replyTo?: number): Message {
    const quoted = this.quoted(replyTo);
    return this.store.addMessage({
      patientId: this.patientId,
      author: 'clinic',
      body,
      fromNumber: this.numbers.clinic,
      toNumber: this.numbers.patient,
      inReplyTo: quoted?.id ?? null,
      meta: { pending: pendingFromClinicMessage(body, this.data.patient), ...(quoted ? { explicitReply: true } : {}) },
    });
  }

  /**
   * Alex's message: saved, matched to an outbound message, then answered by the agent.
   * By default it answers the latest outbound message. If Alex swiped to reply to an older clinic
   * message, that message (and whatever it was waiting for) is used instead.
   */
  /**
   * The clinic's latest appointment offer that no request has come from yet. A reply in between
   * that wasn't about the visit ("thursdar 1:30 works" not understood, or another question) must
   * not make the agent forget what the clinic offered and ask Alex what the visit is for.
   */
  private openOffer(): { pending: Pending; messageId: number } | undefined {
    const isOffer = (m: Message) => m.direction === 'outbound' && (m.meta.pending?.kind === 'appointment_offer' || m.meta.pending?.kind === 'appointment_time');
    const offer = this.store.listMessages(this.patientId).reverse().find(isOffer);
    if (!offer) return undefined;
    const used = this.store.listRequests(this.patientId)
      .some((r) => r.type === 'appointment_request' && r.sourceMessageIds.some((id) => id >= offer.id));
    return used ? undefined : { pending: offer.meta.pending!, messageId: offer.id };
  }

  receivePatientMessage(body: string, replyTo?: number): Promise<{ inbound: Message; reply: Message }> {
    const run = async () => {
      const quoted = this.quoted(replyTo);
      const openOffer = this.openOffer();
      const previous = quoted?.direction === 'outbound' ? quoted : this.store.lastOutbound(this.patientId);
      const inbound = this.store.addMessage({
        patientId: this.patientId,
        author: 'patient',
        body,
        fromNumber: this.numbers.patient,
        toNumber: this.numbers.clinic,
        inReplyTo: quoted?.id ?? previous?.id ?? null,
        meta: quoted ? { explicitReply: true } : {},
      });
      const reply = await runAgent({
        store: this.store,
        data: this.data,
        interpreter: this.interpreter(),
        inbound,
        pending: previous?.meta.pending,
        pendingMessageId: previous?.id,
        openOffer,
      });
      return { inbound, reply };
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

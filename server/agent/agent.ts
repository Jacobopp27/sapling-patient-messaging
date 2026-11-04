// The pipeline for one inbound message:
//   emergency guard (code) → interpreter (rules | Claude) → handler (code + tools) → reply guard (code)
// The interpreter only understands; everything that acts or speaks about safety is code.
import type { ClinicData } from '../data';

import { AgentTools } from '../tools';
import type { DataStore, Message, MessageMeta, Pending, Trace } from '../types';
import { AUTOMATED_INTRO, checkReply, detectEmergency, EMERGENCY_TEXT, GUARD_FALLBACK_TEXT } from './guards';
import { HANDLERS, type HandlerResult, type Turn } from './handlers';
import type { Intent, Interpretation, Interpreter } from './interpretation';
import { changeTarget, ruleInterpreter } from './ruleInterpreter';

/** How a second request in the same message is named back to Alex. */
const ALSO_LABEL: Partial<Record<Intent, string>> = {
  appointment_preference: 'an appointment',
  appointment_status: 'whether your appointment is booked',
  next_appointment: 'your next appointment',
  change_appointment: 'changing an appointment',
  clinic_info: 'clinic information',
  record_info: 'your record',
  not_in_data: 'a clinic policy question',
  refill: 'a refill',
  clinical_question: 'a health question',
  balance: 'your balance',
  billing_issue: 'a billing issue',
  list_requests: 'your requests',
};

export interface AgentInput {
  store: DataStore;
  data: ClinicData;
  interpreter: Interpreter;
  inbound: Message;
  pending?: Pending;
  pendingMessageId?: number;
}

export async function runAgent(input: AgentInput): Promise<Message> {
  const { store, data, inbound } = input;
  const tools = new AgentTools(store, data);
  const reply = (body: string, meta: MessageMeta) =>
    store.addMessage({
      patientId: inbound.patientId, author: 'agent', body, inReplyTo: inbound.id,
      // The reply goes back to the number that texted, from the number it was sent to.
      fromNumber: inbound.toNumber ?? '', toNumber: inbound.fromNumber ?? '',
      meta: { ...meta, requestEvents: tools.events },
    });

  const emergency = (signals: string[], trace: Omit<Trace, 'tools' | 'guards'>) => {
    tools.upsertRequest('emergency', {
      message: inbound.body,
      signals,
      action_taken: 'Patient was sent the emergency rule text (call 911 / nearest ER).',
    }, [inbound.id]);
    return reply(EMERGENCY_TEXT, {
      source: 'emergency_rule',
      trace: { ...trace, tools: tools.calls, guards: { emergency: signals.join(', '), reply: 'exact emergency text' } },
    });
  };

  // 1. Emergency guard: before any model call, in every mode.
  const signals = detectEmergency(inbound.body);
  if (signals.length) return emergency(signals, { interpreter: 'none' });

  // 2. Understand. If Claude fails for any reason, fall back to the local rules.
  const thread = store.listMessages(inbound.patientId).slice(-12).map((m) => `${m.author}: ${m.body}`);
  const ctx = {
    text: inbound.body,
    thread,
    pending: input.pending ? JSON.stringify(input.pending) : undefined,
    today: tools.now().date,
    medications: data.patient.medications.map((m) => m.name),
    appointmentTypes: data.patient.upcoming_appointments.filter((a) => a.status === 'booked').map((a) => a.type),
  };
  let interpreterName = input.interpreter.name;
  let note: string | undefined;
  let interpretation: Interpretation;
  try {
    interpretation = await input.interpreter.interpret(ctx);
  } catch (err) {
    interpretation = await ruleInterpreter.interpret(ctx);
    interpreterName = 'rules';
    note = `Claude interpreter failed, used local rules: ${(err as Error).message}`;
  }

  if (interpretation.possible_emergency) return emergency(['model flagged possible emergency'], { interpreter: interpreterName, interpretation });

  // 3. Decide and act in code. A pending "what's the visit for?" treats Alex's free text as the reason.
  const turn: Turn = { tools, inbound, pending: input.pending, pendingMessageId: input.pendingMessageId };
  if (input.pending?.kind === 'appointment_reason' && ['unknown', 'thanks', 'affirm'].includes(interpretation.intent)) {
    turn.reasonOverride = inbound.body.trim();
    interpretation = { ...interpretation, intent: 'appointment_preference' };
  }
  // "Which one do you mean?" → "the physical": continue the change Alex started.
  const p = input.pending;
  if (p?.kind === 'change_target' && interpretation.intent !== 'clinical_question') {
    const target = changeTarget(inbound.body, ctx);
    if (target) {
      interpretation = {
        date: p.date, window: p.window as Interpretation['window'], time: p.time,
        ...interpretation, intent: 'change_appointment', action: interpretation.action ?? p.action, target,
      };
    }
  }
  // A new day after "what day instead of your physical?" belongs to that change, not to the recheck request.
  if (p?.kind === 'reschedule_time' && interpretation.intent === 'appointment_preference') {
    interpretation = { ...interpretation, intent: 'change_appointment', action: 'reschedule', target: 'booked' };
  }
  let result: HandlerResult = HANDLERS[interpretation.intent](turn, interpretation);

  // One intent per message: anything else Alex asked is named back, never dropped silently.
  const also = (interpretation.also ?? []).map((x) => ALSO_LABEL[x]).filter(Boolean);
  if (also.length) {
    result = { ...result, body: `${result.body} You also asked about ${also.join(' and ')}. I can only handle one thing per message, so please send that again on its own.` };
  }

  // 4. Reply guard: never let a reply claim a booking, promise a deadline or give dosing advice.
  const violations = checkReply(result.body);
  if (violations.length) {
    tools.upsertRequest('other', {
      question: inbound.body,
      reason: 'reply_guard_blocked',
      blocked_reply: result.body,
      violations,
    }, [inbound.id]);
    result = { body: GUARD_FALLBACK_TEXT, source: 'staff_handoff' };
  }

  const disclosed = store.listMessages(inbound.patientId).some((m) => m.author === 'agent' && m.meta.source !== 'emergency_rule');
  if (!disclosed) result = { ...result, body: `${AUTOMATED_INTRO} ${result.body}` };

  return reply(result.body, {
    source: result.source,
    pending: result.pending,
    trace: {
      interpreter: interpreterName,
      interpretation,
      tools: tools.calls,
      guards: { emergency: 'clear', reply: violations.length ? `blocked: ${violations.join(', ')}` : 'ok' },
      ...(note ? { note } : {}),
    },
  });
}

// Claude interpreter: same contract as the rules interpreter, better at free-form language.
// Claude only fills the Interpretation shape (structured output); it never writes the reply,
// never sees tools that act, and can't override the emergency guard or the reply guard.
// Any failure (no key, network, refusal, bad JSON) makes the agent fall back to local rules.
import Anthropic from '@anthropic-ai/sdk';
import { WEEKDAYS } from '../clock';
import { FAQ_TOPICS, INTENTS, RECORD_TOPICS, type Interpretation, type Interpreter, type InterpreterContext } from './interpretation';

export const hasClaudeKey = () => Boolean(process.env.ANTHROPIC_API_KEY);

const MODEL = () => process.env.CLAUDE_MODEL || 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'possible_emergency'],
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    weekday: { type: 'string', enum: WEEKDAYS },
    date: { type: 'string', description: 'YYYY-MM-DD, only if the patient named a calendar date' },
    window: { type: 'string', enum: ['morning', 'afternoon'] },
    time: { type: 'string', description: 'HH:MM 24h, only if the patient named a specific time' },
    topic: { type: 'string', description: `For clinic_info one of: ${FAQ_TOPICS.join(', ')}. For record_info one of: ${RECORD_TOPICS.join(', ')}. For not_in_data a short description of what was asked.` },
    medication: { type: 'string' },
    readings: { type: 'array', items: { type: 'string' } },
    period: { type: 'string' },
    action: { type: 'string', enum: ['reschedule', 'cancel'] },
    target: { type: 'string', enum: ['booked', 'request'] },
    also: { type: 'array', items: { type: 'string', enum: [...INTENTS] } },
    possible_emergency: { type: 'boolean' },
  },
} as const;

const SYSTEM = `You classify one text message from a patient to their primary-care clinic. You do not reply to the patient.
Return the single best intent and any fields the message states. Never invent fields the patient did not say.
Intents:
- affirm / decline: a bare yes/no answering the clinic's last message.
- appointment_preference: wants a visit, or gives/changes a day, date, time or morning/afternoon.
- appointment_status: asks whether a requested appointment is booked/confirmed.
- next_appointment: asks when their next appointment is.
- change_appointment: wants to move (action reschedule) or cancel (action cancel) an appointment. target = booked if they
  mean an appointment already booked on file (e.g. the physical), request if they mean their pending appointment request
  (e.g. the BP recheck); leave target out if it's unclear. Plain day/time changes to a pending request are appointment_preference.
- clinic_info: a question the clinic FAQ covers (topic = ${FAQ_TOPICS.join(' | ')}).
- record_info: a question about their own record (topic = ${RECORD_TOPICS.join(' | ')}).
- not_in_data: a clinic policy question outside those topics (e.g. which insurance plans are accepted).
- refill: asks for a medication refill.
- clinical_question: symptoms, readings, dosing, side effects, or any "should I..." about their health or medication.
- balance: asks about what they owe. billing_issue: disputes a charge, asks for a refund or payment plan.
- list_requests: asks what they have asked for / what is pending.
- thanks, unknown.
If the message asks for more than one thing, put the main one in intent and the others in also. If any part is a
clinical_question, intent must be clinical_question.
Set possible_emergency true if the message could describe a medical emergency (chest pain, trouble breathing, stroke signs, fainting, severe bleeding, self-harm), even if phrased casually.
The message may be in any language; classify it the same way.`;

let client: Anthropic | undefined;

export const claudeInterpreter: Interpreter = {
  name: 'claude',
  async interpret(ctx: InterpreterContext): Promise<Interpretation> {
    client ??= new Anthropic({ timeout: 20_000, maxRetries: 1 });
    const user = [
      `Today is ${ctx.today} (${WEEKDAYS[new Date(`${ctx.today}T00:00:00Z`).getUTCDay()]}).`,
      `Medications on file: ${ctx.medications.join(', ')}.`,
      `Booked appointments on file: ${ctx.appointmentTypes.join(', ') || 'none'}.`,
      ctx.pending ? `The clinic's last message is waiting for: ${ctx.pending}` : 'The clinic is not waiting on a specific answer.',
      'Recent thread (oldest first):',
      ...ctx.thread,
      '',
      `Message to classify: ${ctx.text}`,
    ].join('\n');

    const response = await client.messages.create({
      model: MODEL(),
      max_tokens: 2000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
    });
    if (response.stop_reason === 'refusal') throw new Error('model refused');
    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('no structured output');
    const parsed = JSON.parse(text.text) as Interpretation;
    if (!INTENTS.includes(parsed.intent)) throw new Error(`unknown intent ${parsed.intent}`);
    return parsed;
  },
};

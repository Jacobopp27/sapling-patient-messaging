// Messages an interviewer might type instead of the script's exact wording: paraphrases, typos,
// short forms, emergencies phrased casually, questions about the record, and things the local
// interpreter can't understand (those must fail safe: offer staff, file nothing).
import { describe, expect, it } from 'vitest';
import { EMERGENCY_TEXT } from '../server/agent/guards';
import { interpretWithRules } from '../server/agent/ruleInterpreter';
import { SCRIPT } from '../server/script';
import { CLAIMS_DONE, DOSING, opening, openService, PROMISES_TIME, tempDbFile } from './helpers';

type Ctx = 'fresh' | 'offer' | 'slots' | 'request';

/** fresh: empty thread · offer: after the clinic's outreach · slots: after "yes" (openings listed) · request: after steps 0–3 */
async function thread(ctx: Ctx) {
  const svc = openService(tempDbFile());
  if (ctx !== 'fresh') svc.sendClinicMessage(SCRIPT[0].body);
  if (ctx === 'slots') await svc.receivePatientMessage('yes');
  if (ctx === 'request') for (const n of [1, 2, 3]) await svc.receivePatientMessage(SCRIPT[n].body);
  return svc;
}

async function send(ctx: Ctx, text: string) {
  const svc = await thread(ctx);
  const before = svc.store.listRequests('pt_001').length;
  const { reply } = await svc.receivePatientMessage(text);
  const requests = svc.store.listRequests('pt_001');
  return { reply, body: opening(reply.body), requests, filed: requests.slice(before) };
}

describe('emergencies phrased casually', () => {
  it.each([
    'my chest feels tight',
    "I feel like I'm going to pass out",
    "I can't feel my left arm",
    'my vision is blurry and I have a terrible headache',
    'I want to hurt myself',
  ])('"%s" → exact emergency text', async (text) => {
    const { reply, filed } = await send('fresh', text);
    expect(reply.body).toBe(EMERGENCY_TEXT);
    expect(filed.map((r) => r.type)).toEqual(['emergency']);
  });
});

describe('scheduling paraphrases', () => {
  it.each<[Ctx, string, Record<string, unknown>]>([
    ['offer', 'Yes please, tuesday afternoon works', { date: '2026-11-10', window: 'afternoon' }],
    ['offer', 'tues pm', { date: '2026-11-10', window: 'afternoon' }],
    ['offer', 'nov 12 at 1:30', { date: '2026-11-12', window: 'afternoon', preferred_time: '13:30' }],
    ['slots', 'the 4pm on thursday', { date: '2026-11-12', preferred_time: '16:00' }],
    ['slots', 'can I come in next Thursday morning?', { date: '2026-11-12', window: 'morning' }],
  ])('[%s] "%s" files the right request', async (ctx, text, details) => {
    const { filed, body } = await send(ctx, text);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ type: 'appointment_request', details: { reason: 'BP recheck', ...details } });
    expect(body).toMatch(/not a booking/);
  });

  it('"did you book it?" is a status question, not a new preference', async () => {
    const { body, reply } = await send('request', 'did you book it?');
    expect(body).toMatch(/^Not yet\./);
    expect(reply.meta.requestEvents).toEqual([]);
  });

  it('"can we make it 4pm instead" keeps one request and records the time', async () => {
    const { requests, body } = await send('request', 'can we make it 4pm instead');
    expect(requests).toHaveLength(1);
    expect(requests[0].details).toMatchObject({ date: '2026-11-12', preferred_time: '16:00' });
    expect(body).toMatch(/around 4:00 p\.m\./);
  });

  it('"never mind, I don\'t need the recheck anymore" is noted as a withdrawal', async () => {
    const { requests, body } = await send('request', "never mind, I don't need the recheck anymore");
    expect(requests).toHaveLength(1);
    expect(requests[0].details.patient_wants_to_withdraw).toBeDefined();
    expect(body).toMatch(/you'd like to withdraw it/);
  });

  it('"book me with Dr. Lee tomorrow at 2pm" with no context asks what the visit is for', async () => {
    const { body, filed } = await send('fresh', 'can you book me with Dr. Lee tomorrow at 2pm');
    expect(body).toMatch(/What's the visit for\?/);
    expect(filed).toEqual([]);
  });
});

describe('answers from the record and the FAQ', () => {
  it.each<[string, RegExp]>([
    ['whens my next appt', /annual physical with Dr\. Priya Lee on Thursday, Jan 14, 2027/],
    ['are you open on saturday?', /^We're closed on Saturday, Nov 7 \(weekends\)\./],
    ['do you accept blue shield?', /Your record lists Blue Shield of California PPO/],
    ['can I pay with a card over text?', /https:\/\/pay\.example\.test\/sapling/],
    ['who is my doctor?', /Dr\. Priya Lee/],
    ['what medications am I on?', /Lisinopril 10 mg, once daily/],
    ['how much do I owe?', /\$40\.00/],
  ])('"%s"', async (text, expected) => {
    const { body, filed } = await send('fresh', text);
    expect(body).toMatch(expected);
    expect(filed).toEqual([]);
  });

  it.each(['I need more lisinopril', "I'm almost out of my blood pressure pills"])('"%s" → refill handoff', async (text) => {
    const { filed } = await send('fresh', text);
    expect(filed[0]).toMatchObject({ type: 'refill', details: { medication: 'Lisinopril', pharmacy: expect.stringContaining('Elm Street') } });
  });
});

describe('what the local interpreter cannot understand fails safe', () => {
  it.each(['necesito una cita el martes', "what's the weather like?", 'can I talk to a real person?'])('"%s" → offers staff, files nothing', async (text) => {
    const { body, filed, reply } = await send('fresh', text);
    expect(body).toMatch(/Would you like me to pass your message to the clinic staff\?/);
    expect(filed).toEqual([]);
    expect(reply.meta.pending).toMatchObject({ kind: 'pass_to_staff' });
  });
});

describe('no variation claims a booking, promises a time or gives dosing advice', () => {
  it.each<[Ctx, string]>([
    ['offer', 'yeah sure'], ['slots', 'sounds good, what times do you have?'], ['request', 'has my appointment been confirmed?'],
    ['request', 'did you book it?'], ['fresh', 'my bp was 165/105 this morning, is that bad?'], ['fresh', 'I have a fever of 103'],
    ['fresh', 'what medications am I on?'], ['fresh', 'I need more lisinopril'],
  ])('[%s] "%s"', async (ctx, text) => {
    const { reply } = await send(ctx, text);
    expect(reply.body).not.toMatch(CLAIMS_DONE);
    expect(reply.body).not.toMatch(PROMISES_TIME);
    expect(reply.body).not.toMatch(DOSING);
    expect(reply.meta.trace?.guards.reply).toBe('ok');
  });
});

describe('the clinic offer is remembered across a message the agent did not understand', () => {
  it('your exact thread: "thursdar 1:30 works", then "book thursday", then "Tuesday afternoon works"', async () => {
    const svc = await thread('slots');
    const first = await svc.receivePatientMessage('thursdar 1:30 works');
    expect(opening(first.reply.body)).toMatch(/requested a BP recheck .* Thursday, Nov 12, around 1:30 p\.m\./);
    await svc.receivePatientMessage('book thursday');
    const last = await svc.receivePatientMessage('Tuesday afternoon works');
    const requests = svc.store.listRequests('pt_001');
    expect(requests).toHaveLength(1);
    expect(requests[0].details).toMatchObject({ reason: 'BP recheck', date: '2026-11-10', window: 'afternoon' });
    expect(last.reply.body).not.toMatch(/What's the visit for/);
  });

  it('a question in between does not make the agent ask what the visit is for', async () => {
    const svc = await thread('slots');
    await svc.receivePatientMessage("what's the weather like?");
    const { reply } = await svc.receivePatientMessage('book thursday');
    expect(reply.body).not.toMatch(/What's the visit for/);
    const [r] = svc.store.listRequests('pt_001');
    expect(r.details).toMatchObject({ reason: 'BP recheck', provider: 'Dr. Priya Lee', date: '2026-11-12' });
    expect(r.sourceMessageIds[0]).toBe(1); // still linked to the clinic's outreach
  });

  it('once a request came from the offer, a new unrelated visit still asks for its reason', async () => {
    const svc = await thread('request');
    svc.store.updateRequest(1, { status: 'cancelled' });
    const { reply } = await svc.receivePatientMessage('can I book an appointment for Friday?');
    expect(reply.body).toMatch(/What's the visit for\?/);
  });
});

describe('weekday typos', () => {
  const ctx = (text: string) => ({ text, thread: [], today: '2026-11-04', medications: ['Lisinopril'], appointmentTypes: ['Annual physical'] });
  it.each([
    ['thursdar 1:30 works', 'thursday', '13:30'],
    ['wensday morning', 'wednesday', undefined],
    ['tuesdy pm', 'tuesday', undefined],
  ])('"%s" → %s', (text, weekday, time) => {
    const i = interpretWithRules(ctx(text));
    expect(i).toMatchObject({ intent: 'appointment_preference', weekday });
    expect(i.time).toBe(time);
  });
  it.each(["it's sunny today", 'we have a wedding', 'the fridge broke'])('"%s" is not a weekday', (text) => {
    expect(interpretWithRules(ctx(text)).weekday).toBeUndefined();
  });
});

// Behaviour around the script: the scenario clock, date resolution, dedupe, offers, persistence.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localNow, resolveWeekday } from '../server/clock';
import { BUSINESS_HOURS, DATA_DIR, loadClinicData } from '../server/data';
import { SCRIPT } from '../server/script';
import { opening, openService, tempDbFile } from './helpers';

const WED = '2026-11-04';

describe('scenario clock', () => {
  it('reads "now" from settings in Pacific time, not the machine clock', () => {
    expect(localNow('2026-11-04T10:00:00-08:00')).toEqual({ date: WED, weekday: 3, time: '10:00' });
    expect(localNow('2026-11-05T03:00:00Z')).toEqual({ date: WED, weekday: 3, time: '19:00' });
  });

  it.each([
    ['2026-11-07T11:00:00-08:00', /^We're closed today \(Saturday\)\./],
    ['2026-11-04T17:30:00-08:00', /^We closed at 5:00 p\.m\. Pacific today \(Wednesday\)\./],
    ['2026-11-04T08:00:00-08:00', /^Today \(Wednesday\) we're open 9:00 a\.m\. to 5:00 p\.m\. Pacific\./],
  ])('hours answer follows the configured now (%s)', async (now, expected) => {
    const svc = openService(tempDbFile(), now);
    const { reply } = await svc.receivePatientMessage('what time do you close today?');
    expect(opening(reply.body)).toMatch(expected);
  });

  it('the structured business hours match the FAQ text', () => {
    const faq = readFileSync(path.join(DATA_DIR, 'clinic_faq.md'), 'utf8');
    expect(faq).toContain('Monday–Friday, 9:00 a.m.–5:00 p.m. Pacific');
    expect(BUSINESS_HOURS).toEqual({ days: [1, 2, 3, 4, 5], open: '09:00', close: '17:00' });
  });
});

describe('date resolution', () => {
  it('"Tuesday" on Wed Nov 4 is Tue Nov 10', () => expect(resolveWeekday(WED, 2)).toBe('2026-11-10'));
  it('"Thursday" with no context is tomorrow, Thu Nov 5', () => expect(resolveWeekday(WED, 4)).toBe('2026-11-05'));
  it('"Thursday instead" of Tue Nov 10 is Thu Nov 12, the same week', () => expect(resolveWeekday(WED, 4, '2026-11-10')).toBe('2026-11-12'));
  it('"Monday instead" of Tue Nov 10 is Mon Nov 9', () => expect(resolveWeekday(WED, 1, '2026-11-10')).toBe('2026-11-09'));
  it('never resolves to today or the past', () => expect(resolveWeekday(WED, 3)).toBe('2026-11-11'));
});

describe('appointment requests', () => {
  it('a specific slot is recorded when Alex picks one', async () => {
    const svc = openService(tempDbFile());
    svc.sendClinicMessage(SCRIPT[0].body);
    await svc.receivePatientMessage('yes');
    const { reply } = await svc.receivePatientMessage('Thursday at 4pm please');
    const [r] = svc.store.listRequests('pt_001');
    // The openings just listed were Tue Nov 10 and Thu Nov 12, so "Thursday" is Nov 12, not tomorrow.
    expect(r.details).toMatchObject({ date: '2026-11-12', window: 'afternoon', preferred_time: '16:00', matching_open_slots: ['16:00'] });
    // An open time was picked: say it back as the one, not the whole list.
    expect(reply.body).toMatch(/requested a BP recheck with Dr\. Priya Lee for Thursday, Nov 12, at 4:00 p\.m\. That's one of Dr\. Lee's open times\./);
  });

  it('several changes keep one request, and the latest preference wins', async () => {
    const svc = openService(tempDbFile());
    svc.sendClinicMessage(SCRIPT[0].body);
    for (const m of ['yes', 'Tuesday afternoon works', 'actually Thursday', 'morning would be better']) await svc.receivePatientMessage(m);
    const reqs = svc.store.listRequests('pt_001');
    expect(reqs).toHaveLength(1);
    expect(reqs[0].details).toMatchObject({ date: '2026-11-12', window: 'morning', matching_open_slots: [] });
  });

  it('without a known reason, asks what the visit is for and uses the answer', async () => {
    const svc = openService(tempDbFile());
    const first = await svc.receivePatientMessage('can I book an appointment for Tuesday afternoon?');
    expect(first.reply.body).toMatch(/What's the visit for\?/);
    // A symptom as the answer is still routed as clinical (safety first), not used as a visit reason.
    await svc.receivePatientMessage('my knee hurts and will not stop');
    expect(svc.store.listRequests('pt_001').map((r) => r.type)).toEqual(['clinical_question']);
    // A neutral answer becomes the reason:
    const svc2 = openService(tempDbFile());
    await svc2.receivePatientMessage('can I book an appointment for Tuesday afternoon?');
    await svc2.receivePatientMessage('annual flu shot');
    const [r] = svc2.store.listRequests('pt_001');
    expect(r.details).toMatchObject({ reason: 'annual flu shot', date: '2026-11-10', window: 'afternoon' });
  });
});

describe('offers to pass a question to staff', () => {
  it('"yes" after the Aetna answer files an `other` request linked to the question', async () => {
    const svc = openService(tempDbFile());
    const q = await svc.receivePatientMessage('do you take Aetna?');
    const { reply } = await svc.receivePatientMessage('yes please');
    const [r] = svc.store.listRequests('pt_001');
    expect(r).toMatchObject({ type: 'other', details: { question: 'do you take Aetna?' } });
    expect(r.sourceMessageIds).toEqual([q.inbound.id, q.reply.id + 1]);
    expect(reply.body).toMatch(/pending staff review/);
  });

  it('"no" files nothing', async () => {
    const svc = openService(tempDbFile());
    await svc.receivePatientMessage('do you take Aetna?');
    await svc.receivePatientMessage('no thanks');
    expect(svc.store.listRequests('pt_001')).toEqual([]);
  });
});

describe('swipe to reply', () => {
  it('"yes" swiped onto an older clinic offer is matched to that offer, not the latest message', async () => {
    const svc = openService(tempDbFile());
    const offer = svc.sendClinicMessage(SCRIPT[0].body);
    await svc.receivePatientMessage('what time do you close today?');
    // Without a swipe, "yes" answers the hours reply, which offered nothing:
    const plain = await svc.receivePatientMessage('yes');
    expect(plain.reply.body).toMatch(/What can I help you with/);
    // Swiped onto the clinic's offer, it continues the booking flow:
    const { inbound, reply } = await svc.receivePatientMessage('yes', offer.id);
    expect(inbound).toMatchObject({ inReplyTo: offer.id, meta: { explicitReply: true } });
    expect(reply.body).toMatch(/What day and time work best/);
    await svc.receivePatientMessage('Tuesday afternoon works');
    const [r] = svc.store.listRequests('pt_001');
    expect(r.sourceMessageIds).toEqual([offer.id, inbound.id, inbound.id + 2]);
  });

  it('a reply id from another thread or a missing message is ignored', async () => {
    const svc = openService(tempDbFile());
    const { inbound } = await svc.receivePatientMessage('what time do you close today?', 999);
    expect(inbound.inReplyTo).toBeNull();
    expect(inbound.meta.explicitReply).toBeUndefined();
  });

  it('clinic staff can quote a patient message', () => {
    const svc = openService(tempDbFile());
    return svc.receivePatientMessage('do you take Aetna?').then(({ inbound }) => {
      const m = svc.sendClinicMessage('Checking with billing on that one.', inbound.id);
      expect(m).toMatchObject({ inReplyTo: inbound.id, meta: { explicitReply: true } });
    });
  });
});

describe('refills', () => {
  it('a second refill ask updates the open refill instead of duplicating it', async () => {
    const svc = openService(tempDbFile());
    await svc.receivePatientMessage('can I get a refill on my BP med');
    const { reply } = await svc.receivePatientMessage('I need a refill of lisinopril please');
    expect(svc.store.listRequests('pt_001')).toHaveLength(1);
    expect(reply.body).toMatch(/already have a refill request/);
  });
});

describe('persistence', () => {
  it('a pending offer survives a restart: "yes" after restart still matches message 0', async () => {
    const file = tempDbFile();
    const a = openService(file);
    const offer = a.sendClinicMessage(SCRIPT[0].body);
    a.store.close();
    const b = openService(file);
    const { inbound, reply } = await b.receivePatientMessage('yes');
    expect(inbound.inReplyTo).toBe(offer.id);
    expect(reply.body).toMatch(/What day and time work best/);
  });

  it('supplied data files are never written', async () => {
    const before = readFileSync(path.join(DATA_DIR, 'alex_morgan.json'), 'utf8');
    const svc = openService(tempDbFile());
    svc.sendClinicMessage(SCRIPT[0].body);
    for (const s of SCRIPT.slice(1)) await svc.receivePatientMessage(s.body);
    expect(readFileSync(path.join(DATA_DIR, 'alex_morgan.json'), 'utf8')).toBe(before);
    expect(loadClinicData().patient.upcoming_appointments).toHaveLength(1);
  });
});

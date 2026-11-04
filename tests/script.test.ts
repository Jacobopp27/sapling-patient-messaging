// Phase 1 scenario script, steps 0–12, run in order in ONE conversation on a real SQLite file.
// Step 12 closes the store and reopens the same file: the "restart the process" step.
import { describe, expect, it } from 'vitest';
import { EMERGENCY_TEXT } from '../server/agent/guards';
import { missingFields } from '../server/requests';
import { SCRIPT } from '../server/script';
import type { Message } from '../server/types';
import { CLAIMS_DONE, DOSING, openService, PROMISES_TIME, tempDbFile } from './helpers';

describe('Phase 1 script (steps 0–12)', () => {
  const file = tempDbFile();
  let svc = openService(file);
  const pid = 'pt_001';
  const ids: Record<number, number> = {};

  async function step(n: number): Promise<{ inbound: Message; reply: Message }> {
    const s = SCRIPT[n];
    const out = await svc.receivePatientMessage(s.body);
    ids[n] = out.inbound.id;
    return out;
  }
  const requests = (type?: string) => svc.store.listRequests(pid).filter((r) => !type || r.type === type);

  it('step 0: clinic outbound is displayed and saved; nothing is sent', () => {
    const msg = svc.sendClinicMessage(SCRIPT[0].body);
    ids[0] = msg.id;
    expect(msg).toMatchObject({ author: 'clinic', direction: 'outbound', body: SCRIPT[0].body });
    expect(msg.meta.pending).toMatchObject({ kind: 'appointment_offer', reason: 'BP recheck', provider: 'Dr. Priya Lee' });
    expect(svc.store.listMessages(pid)).toHaveLength(1);
    expect(requests()).toHaveLength(0);
  });

  it('step 1: "yes" is matched to message 0; asks when, suggests real open slots, does not ask the reason', async () => {
    const { inbound, reply } = await step(1);
    expect(inbound.inReplyTo).toBe(ids[0]);
    expect(reply.body).toMatch(/What day and time work best/);
    expect(reply.body).toContain('Tuesday, Nov 10 (2:00 p.m. or 3:30 p.m.)');
    expect(reply.body).toContain('Thursday, Nov 12 (1:30 p.m. or 4:00 p.m.)');
    expect(reply.body).toContain('BP recheck');
    expect(reply.body).not.toMatch(/what('s| is) (it|the visit|this) for|reason/i);
    expect(requests()).toHaveLength(0);
  });

  it('step 2: "Tuesday afternoon" → one appointment_request for Tue Nov 10 afternoon, said back, pending', async () => {
    const { reply } = await step(2);
    expect(reply.body).toContain('Tuesday, Nov 10, in the afternoon');
    expect(reply.body).toMatch(/pending staff review/);
    expect(reply.body).toMatch(/not a booking/);
    expect(reply.body).not.toMatch(CLAIMS_DONE);
    const appts = requests('appointment_request');
    expect(appts).toHaveLength(1);
    expect(appts[0].status).toBe('pending_staff');
    expect(appts[0].details).toMatchObject({
      reason: 'BP recheck', provider: 'Dr. Priya Lee', date: '2026-11-10', window: 'afternoon',
      matching_open_slots: ['14:00', '15:30'],
    });
    expect(appts[0].sourceMessageIds).toEqual([ids[0], ids[1], ids[2]]);
    expect(missingFields('appointment_request', appts[0].details)).toEqual([]);
    expect(reply.meta.requestEvents).toEqual([{ requestId: appts[0].id, action: 'created' }]);
  });

  it('step 3: "Thursday instead" updates the SAME request to Thu Nov 12, keeping the afternoon window', async () => {
    const before = requests('appointment_request')[0];
    const { reply } = await step(3);
    const appts = requests('appointment_request');
    expect(appts).toHaveLength(1);
    expect(appts[0].id).toBe(before.id);
    expect(appts[0].details).toMatchObject({ date: '2026-11-12', window: 'afternoon', matching_open_slots: ['13:30', '16:00'] });
    expect(appts[0].sourceMessageIds).toContain(ids[3]);
    expect(reply.body).toContain('Thursday, Nov 12, in the afternoon');
    expect(reply.body).toMatch(/still one request/);
    expect(reply.body).toMatch(/still pending staff review, not booked/);
    expect(reply.meta.requestEvents).toEqual([{ requestId: before.id, action: 'updated' }]);
  });

  it('step 4: "is it booked yet?" reads the real status: pending, not booked, no timeline', async () => {
    const { reply } = await step(4);
    expect(reply.body).toMatch(/^Not yet/);
    expect(reply.body).toMatch(/pending staff review/);
    expect(reply.body).toMatch(/isn't booked/);
    expect(reply.body).toMatch(/aren't monitored continuously/);
    expect(reply.body).not.toMatch(PROMISES_TIME);
    expect(reply.body).not.toMatch(CLAIMS_DONE);
  });

  it('step 5: next appointment is the Jan 14, 2027 physical; the recheck is kept apart as a pending request', async () => {
    const { reply } = await step(5);
    expect(reply.body).toMatch(/^Your next booked appointment is your annual physical with Dr\. Priya Lee on Thursday, Jan 14, 2027 at 9:30 a\.m\. Separately/);
    expect(reply.body).toMatch(/Separately, your BP recheck .*Thursday, Nov 12.* is a request that's pending staff review\. It isn't a booked appointment yet\./);
  });

  it('step 6: closes at 5:00 p.m. Pacific today (Wednesday)', async () => {
    const { reply } = await step(6);
    expect(reply.body).toMatch(/^We close at 5:00 p\.m\. Pacific today \(Wednesday\)\./);
    expect(reply.meta.source).toBe('faq');
  });

  it('step 7: Aetna is not in the data: says so, no guessing, offers to pass it to staff (no request yet)', async () => {
    const count = requests().length;
    const { reply } = await step(7);
    expect(reply.body).toMatch(/I don't have information about which insurance plans the clinic accepts/);
    expect(reply.body).toMatch(/Would you like me to pass your question to the clinic staff\?$/);
    expect(reply.body).not.toMatch(/\bwe (do|don't) (take|accept)\b|\bAetna is\b/i);
    expect(requests()).toHaveLength(count);
    expect(reply.meta.pending).toMatchObject({ kind: 'pass_to_staff' });
  });

  it('step 8: refill handoff for Lisinopril 10 mg once daily with Elm Street Pharmacy, without asking Alex anything', async () => {
    const { reply } = await step(8);
    const [refill] = requests('refill');
    expect(refill.details).toMatchObject({
      medication: 'Lisinopril', dose: '10 mg', frequency: 'once daily', refills_remaining: 0,
      pharmacy: 'Elm Street Pharmacy, (555) 010-0142',
    });
    expect(missingFields('refill', refill.details)).toEqual([]);
    expect(reply.body).toContain('Lisinopril 10 mg, once daily');
    expect(reply.body).toContain('Elm Street Pharmacy');
    expect(reply.body).toMatch(/pending staff review, not approved/);
    expect(reply.body).not.toContain('?');
  });

  it('step 9 (safety): no medical advice; clinical_question captures readings and question; clinician will review', async () => {
    const { reply } = await step(9);
    expect(reply.body).toMatch(/^I can't give medical advice over text/);
    expect(reply.body).toMatch(/to a clinician to review/);
    expect(reply.body).toMatch(/aren't monitored continuously/);
    expect(reply.body).not.toMatch(DOSING);
    expect(reply.body).not.toMatch(/\b(two|2) pills\b/i);
    const [q] = requests('clinical_question');
    expect(q.status).toBe('pending_staff');
    expect(q.details).toMatchObject({ readings: ['150/95'], period: 'all week', patient_question: SCRIPT[9].body });
    expect(q.details.current_medications).toBe('Lisinopril 10 mg once daily');
  });

  it('step 10: $40 is the Oct 6 copay, with the payment link from the FAQ', async () => {
    const count = requests().length;
    const { reply } = await step(10);
    expect(reply.body).toContain('$40.00');
    expect(reply.body).toContain('"Copay for Oct 6, 2026 visit"');
    expect(reply.body).toContain('https://pay.example.test/sapling');
    expect(requests()).toHaveLength(count);
  });

  it('step 11 (safety): the emergency rule word for word and nothing else; emergency handoff logged', async () => {
    const { reply } = await step(11);
    expect(reply.body).toBe(EMERGENCY_TEXT);
    expect(reply.meta.trace?.interpreter).toBe('none');
    const [em] = requests('emergency');
    expect(em.status).toBe('pending_staff');
    expect(em.details.message).toBe(SCRIPT[11].body);
    expect(em.details.signals).toEqual(expect.arrayContaining(['chest pain', 'numbness / weakness']));
    expect(em.sourceMessageIds).toEqual([ids[11]]);
  });

  it('step 12: after a restart, lists the recheck (Thu Nov 12, afternoon), the refill and the clinical question', async () => {
    const messagesBefore = svc.store.listMessages(pid).length;
    const requestsBefore = svc.store.listRequests(pid);
    svc.store.close();
    svc = openService(file); // the restart: new Store + service on the same SQLite file
    expect(svc.store.listMessages(pid)).toHaveLength(messagesBefore);
    expect(svc.store.listRequests(pid)).toEqual(requestsBefore);

    const { reply } = await step(12);
    const lines = reply.body.split('\n');
    expect(lines[0]).toMatch(/Each one is pending staff review/);
    expect(lines[1]).toBe('1) A BP recheck with Dr. Priya Lee on Thursday, Nov 12, in the afternoon (a request, not booked yet)');
    expect(lines[2]).toBe('2) A refill of Lisinopril 10 mg, once daily, at Elm Street Pharmacy');
    expect(lines[3]).toBe('3) Your question for a clinician about your readings (around 150/95)');
    expect(reply.body).not.toMatch(/emergency|chest|Aetna|insurance/i);

    // Exactly one of each: no duplicates anywhere in the run.
    expect(svc.store.listRequests(pid).map((r) => r.type)).toEqual(['appointment_request', 'refill', 'clinical_question', 'emergency']);
    svc.store.close();
  });
});

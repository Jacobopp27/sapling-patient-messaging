// Traps the script doesn't spell out but the flow needs: the booked physical vs the recheck request,
// staff closing a request, closed days, the running clock, phone metadata, a declined outreach and
// two requests in one message.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATED_INTRO, EMERGENCY_TEXT } from '../server/agent/guards';
import { federalHoliday, federalHolidays, isRealDate, notADate } from '../server/clock';
import { SCRIPT } from '../server/script';
import { CLAIMS_DONE, opening, openService, tempDbFile } from './helpers';

const pid = 'pt_001';

/** Steps 0–3: the recheck request for Thu Nov 12, afternoon. */
async function withRecheckRequest() {
  const svc = openService(tempDbFile());
  svc.sendClinicMessage(SCRIPT[0].body);
  for (const n of [1, 2, 3]) await svc.receivePatientMessage(SCRIPT[n].body);
  return svc;
}
const ofType = (svc: ReturnType<typeof openService>, type: string) => svc.store.listRequests(pid).filter((r) => r.type === type);
const recheckDetails = { reason: 'BP recheck', date: '2026-11-12', window: 'afternoon' };

describe('the booked physical is not the recheck request', () => {
  it('"move my physical to Thursday" files its own change request and leaves the recheck alone', async () => {
    const svc = await withRecheckRequest();
    const { reply } = await svc.receivePatientMessage('can we move my physical to Thursday?');
    expect(ofType(svc, 'appointment_request')).toHaveLength(1);
    expect(ofType(svc, 'appointment_request')[0].details).toMatchObject(recheckDetails);
    const [change] = ofType(svc, 'appointment_change');
    expect(change.details).toMatchObject({
      action: 'reschedule', type: 'Annual physical', current_date: '2027-01-14', current_time: '09:30', preferred_date: '2026-11-05',
    });
    expect(reply.body).toMatch(/move your annual physical with Dr\. Priya Lee on Thursday, Jan 14, 2027 at 9:30 a\.m\. to Thursday, Nov 5/);
    expect(reply.body).toMatch(/not a booking/);
    expect(reply.body).not.toMatch(CLAIMS_DONE);
  });

  it('a follow-up day updates that change request, not the recheck', async () => {
    const svc = await withRecheckRequest();
    await svc.receivePatientMessage('can we move my physical?');
    const { reply } = await svc.receivePatientMessage('Friday morning');
    await svc.receivePatientMessage('actually Monday morning');
    expect(ofType(svc, 'appointment_request')[0].details).toMatchObject(recheckDetails);
    const changes = ofType(svc, 'appointment_change');
    expect(changes).toHaveLength(1);
    expect(changes[0].details).toMatchObject({ preferred_date: '2026-11-09', preferred_window: 'morning' });
    expect(reply.body).toMatch(/to Friday, Nov 6, in the morning/);
  });

  it('"cancel my physical" files a cancellation request instead of only quoting the policy', async () => {
    const svc = await withRecheckRequest();
    const { reply } = await svc.receivePatientMessage('I need to cancel my physical');
    expect(ofType(svc, 'appointment_change')[0].details).toMatchObject({ action: 'cancel', current_date: '2027-01-14' });
    expect(ofType(svc, 'appointment_request')[0].details).toMatchObject(recheckDetails);
    expect(reply.body).toMatch(/asked the clinic staff to cancel your annual physical/);
    expect(reply.body).toMatch(/stays on your schedule/);
    expect(reply.body).toMatch(/24 hours' notice/);
    expect(reply.body).not.toMatch(CLAIMS_DONE);

    const next = await svc.receivePatientMessage('when is my next appointment?');
    expect(next.reply.body).toMatch(/You've asked to cancel it, and that's pending staff review/);
  });

  it('asks which one when "my appointment" could be either, then continues', async () => {
    const svc = await withRecheckRequest();
    const { reply } = await svc.receivePatientMessage('can I cancel my appointment?');
    expect(reply.body).toMatch(/Do you mean your booked annual physical .* or your request for a BP recheck/);
    expect(svc.store.listRequests(pid)).toHaveLength(1);
    await svc.receivePatientMessage('the physical');
    expect(ofType(svc, 'appointment_change')[0].details).toMatchObject({ action: 'cancel' });
  });

  it('cancelling the recheck notes it on that request; nothing new is filed', async () => {
    const svc = await withRecheckRequest();
    const { reply } = await svc.receivePatientMessage('please cancel the recheck');
    const requests = svc.store.listRequests(pid);
    expect(requests).toHaveLength(1);
    expect(requests[0].details).toMatchObject({ ...recheckDetails, patient_wants_to_withdraw: 'please cancel the recheck' });
    expect(reply.body).toMatch(/you'd like to withdraw it/);
  });

  it('a cancellation-policy question is still just the FAQ', async () => {
    const svc = openService(tempDbFile());
    const { reply } = await svc.receivePatientMessage("what's your cancellation policy?");
    expect(reply.body).toMatch(/24 hours' notice/);
    expect(svc.store.listRequests(pid)).toEqual([]);
  });
});

describe('after staff close a request', () => {
  it('"completed" is reported as completed, not as "no request"', async () => {
    const svc = await withRecheckRequest();
    svc.store.updateRequest(1, { status: 'completed' });
    const status = await svc.receivePatientMessage('is it booked yet?');
    expect(status.reply.body).toMatch(/was marked completed by the clinic staff/);
    expect(status.reply.body).toMatch(/can't confirm a date or time/);
    expect(status.reply.body).not.toMatch(/You don't have an appointment request/);
    expect(status.reply.body).not.toMatch(CLAIMS_DONE);

    const list = await svc.receivePatientMessage('what have I asked you for so far?');
    expect(list.reply.body).toMatch(/Already handled by staff:\n- Your BP recheck with Dr\. Priya Lee: marked completed/);
    expect(svc.store.listRequests(pid)).toHaveLength(1);
  });

  it('"cancelled" offers to request it again, and "yes" starts a new request', async () => {
    const svc = await withRecheckRequest();
    svc.store.updateRequest(1, { status: 'cancelled' });
    const status = await svc.receivePatientMessage('any update?');
    expect(status.reply.body).toMatch(/was closed by the clinic staff.*request it again\?/);
    await svc.receivePatientMessage('yes');
    await svc.receivePatientMessage('Tuesday afternoon works');
    const appts = ofType(svc, 'appointment_request');
    expect(appts.map((r) => r.status)).toEqual(['cancelled', 'pending_staff']);
    expect(appts[1].details).toMatchObject({ reason: 'BP recheck', date: '2026-11-10' });
  });
});

describe('closed days: weekends and federal holidays', () => {
  it('computes the 2026 federal holidays, observed dates included', () => {
    const h = federalHolidays(2026);
    expect(h['2026-11-11']).toBe('Veterans Day');
    expect(h['2026-11-26']).toBe('Thanksgiving Day');
    expect(h['2026-07-03']).toBe('Independence Day'); // Jul 4, 2026 is a Saturday
    expect(federalHoliday('2027-12-31')).toBe("New Year's Day"); // Jan 1, 2028 is a Saturday
    expect(federalHoliday('2026-11-12')).toBeUndefined();
  });

  it('"Wednesday" (Nov 11, Veterans Day) is not requested; Alex is asked for another day', async () => {
    const svc = openService(tempDbFile());
    svc.sendClinicMessage(SCRIPT[0].body);
    await svc.receivePatientMessage('yes');
    const { reply } = await svc.receivePatientMessage('Wednesday morning');
    expect(reply.body).toMatch(/closed on Wednesday, Nov 11 \(Veterans Day\)/);
    expect(reply.body).toMatch(/What other day works/);
    expect(svc.store.listRequests(pid)).toEqual([]);
    await svc.receivePatientMessage('Tuesday afternoon');
    expect(ofType(svc, 'appointment_request')[0].details).toMatchObject({ reason: 'BP recheck', date: '2026-11-10' });
    // The offer, "yes", the closed-day attempt and the day that worked.
    expect(ofType(svc, 'appointment_request')[0].sourceMessageIds).toEqual([1, 2, 4, 6]);
  });

  it('"actually Saturday" keeps the existing request as it was', async () => {
    const svc = await withRecheckRequest();
    const { reply } = await svc.receivePatientMessage('actually Saturday');
    expect(reply.body).toMatch(/closed on Saturday, Nov 14 \(weekends\)/);
    expect(reply.body).toMatch(/still for Thursday, Nov 12, in the afternoon/);
    expect(ofType(svc, 'appointment_request')[0].details).toMatchObject(recheckDetails);
  });

  it('the hours answer on a holiday says closed', async () => {
    const svc = openService(tempDbFile(), '2026-11-11T10:00:00-08:00');
    const { reply } = await svc.receivePatientMessage('what time do you close today?');
    expect(opening(reply.body)).toMatch(/^We're closed today \(Wednesday, Veterans Day\)\./);
  });
});

describe('scenario clock keeps running', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a request updated later has a later updated_at; setting "now" restarts the clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z')); // the machine clock is irrelevant, only elapsed time counts
    const file = tempDbFile();
    let svc = openService(file);
    svc.sendClinicMessage(SCRIPT[0].body);
    await svc.receivePatientMessage('yes');
    await svc.receivePatientMessage('Tuesday afternoon works');
    vi.advanceTimersByTime(5 * 60_000);
    svc.store.close();
    svc = openService(file); // a restart doesn't stop it either
    await svc.receivePatientMessage('actually can we do Thursday instead');
    const [r] = svc.store.listRequests(pid);
    expect(r.createdAt).toBe('2026-11-04T18:00:00.000Z'); // Wed Nov 4, 10:00 PT
    expect(r.updatedAt).toBe('2026-11-04T18:05:00.000Z');

    svc.store.updateSettings({ now: '2026-11-07T11:00:00-08:00' });
    expect(svc.store.now()).toBe('2026-11-07T19:00:00.000Z');
  });
});

describe('simulated SMS metadata', () => {
  it('every message stores the sender and recipient numbers', async () => {
    const svc = openService(tempDbFile());
    const clinic = svc.sendClinicMessage(SCRIPT[0].body);
    const { inbound, reply } = await svc.receivePatientMessage('yes');
    const alex = '+1-555-010-0199';
    const office = '(555) 010-0100';
    expect(clinic).toMatchObject({ fromNumber: office, toNumber: alex });
    expect(inbound).toMatchObject({ fromNumber: alex, toNumber: office });
    expect(reply).toMatchObject({ fromNumber: office, toNumber: alex });
  });
});

describe('automated disclosure', () => {
  it('the first automated reply says so in the text; later ones and the emergency text do not', async () => {
    const svc = openService(tempDbFile());
    const first = await svc.receivePatientMessage('I have chest pain');
    expect(first.reply.body).toBe(EMERGENCY_TEXT);
    const second = await svc.receivePatientMessage('what time do you close today?');
    expect(second.reply.body.startsWith(AUTOMATED_INTRO)).toBe(true);
    const third = await svc.receivePatientMessage('where are you located?');
    expect(third.reply.body).not.toContain(AUTOMATED_INTRO);
  });
});

describe('declining the clinic outreach', () => {
  it('"no thanks" to the recheck offer is logged for staff, and not listed as something Alex asked for', async () => {
    const svc = openService(tempDbFile());
    const offer = svc.sendClinicMessage(SCRIPT[0].body);
    const { inbound, reply } = await svc.receivePatientMessage('no thanks');
    const [r] = svc.store.listRequests(pid);
    expect(r).toMatchObject({
      type: 'outreach_declined',
      details: { offer: 'BP recheck with Dr. Priya Lee', patient_reply: 'no thanks' },
      sourceMessageIds: [offer.id, inbound.id],
    });
    expect(r.details.context).toMatch(/Recheck BP in about 4 weeks/);
    expect(reply.body).toMatch(/I won't request the BP recheck/);

    const list = await svc.receivePatientMessage('what have I asked you for so far?');
    expect(list.reply.body).toMatch(/^You don't have any requests waiting for staff right now\.$/);
  });
});

describe('two requests in one message', () => {
  it('handles the first and names the second instead of dropping it', async () => {
    const svc = await withRecheckRequest();
    const { reply } = await svc.receivePatientMessage('can I get a refill on my BP med and also is it booked yet?');
    expect(ofType(svc, 'refill')).toHaveLength(1);
    expect(reply.body).toMatch(/You also asked about whether your appointment is booked\. .*send that again on its own\.$/);
  });

  it('no script step triggers the notice', async () => {
    const svc = openService(tempDbFile());
    svc.sendClinicMessage(SCRIPT[0].body);
    for (const s of SCRIPT.slice(1, 12)) {
      const { reply } = await svc.receivePatientMessage(s.body);
      expect(reply.body).not.toMatch(/You also asked/);
    }
  });
});

describe('impossible dates', () => {
  it('"nov 31" is not filed as Dec 1: the agent says so, and the next day continues the offer', async () => {
    const svc = openService(tempDbFile());
    svc.sendClinicMessage(SCRIPT[0].body);
    await svc.receivePatientMessage('yes');
    const { reply } = await svc.receivePatientMessage('nov 31 in the afternoon');
    expect(reply.body).toBe("There's no November 31: November has 30 days. What day works for you?");
    expect(svc.store.listRequests('pt_001')).toEqual([]);
    await svc.receivePatientMessage('Thursday afternoon then');
    const [r] = svc.store.listRequests('pt_001');
    expect(r.details).toMatchObject({ reason: 'BP recheck', date: '2026-11-12', window: 'afternoon' });
  });

  it('knows month lengths and leap years', () => {
    expect(isRealDate('2026-11-30')).toBe(true);
    expect(isRealDate('2026-11-31')).toBe(false);
    expect(isRealDate('2027-02-29')).toBe(false);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(notADate('2027-02-30')).toBe("There's no February 30: February has 28 days.");
  });
});

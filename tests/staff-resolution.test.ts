// Closing the loop with staff: staff record what actually happened to a request, and the agent
// reports that back truthfully. The agent still can't book, approve or cancel anything itself.
import { describe, expect, it } from 'vitest';
import { checkReply } from '../server/agent/guards';
import { draftUpdate, ResolveError, resolveRequest } from '../server/resolutions';
import { SCRIPT } from '../server/script';
import { opening, openService, tempDbFile } from './helpers';

const pid = 'pt_001';

/** Steps 0–3 and the refill: request #1 (recheck, Thu Nov 12 afternoon) and #2 (refill). */
async function setup() {
  const svc = openService(tempDbFile());
  svc.sendClinicMessage(SCRIPT[0].body);
  for (const n of [1, 2, 3, 8]) await svc.receivePatientMessage(SCRIPT[n].body);
  return svc;
}
const ask = async (svc: ReturnType<typeof openService>, text: string) => {
  const { reply } = await svc.receivePatientMessage(text);
  expect(checkReply(reply.body), reply.body).toEqual([]); // the reply guard never had to step in
  return opening(reply.body);
};
const bookRecheck = (svc: ReturnType<typeof openService>, message?: string) =>
  resolveRequest(svc, 1, { outcome: 'booked', date: '2026-11-12', time: '13:30', message });

describe('a visit staff booked', () => {
  it('"is it booked yet?" reports the booking staff recorded', async () => {
    const svc = await setup();
    expect(await ask(svc, 'is it booked yet?')).toMatch(/^Not yet\./);
    bookRecheck(svc);
    expect(await ask(svc, 'is it booked yet?'))
      .toBe('Yes. Clinic staff booked your BP recheck with Dr. Priya Lee for Thursday, Nov 12 at 1:30 p.m. If you need to change it, reply here.');
    expect(svc.store.getRequest(1)).toMatchObject({ status: 'completed', resolution: { outcome: 'booked', appointment: { date: '2026-11-12', time: '13:30', provider: 'Dr. Priya Lee' } } });
  });

  it('becomes the next appointment, ahead of the physical, and shows as booked in the list', async () => {
    const svc = await setup();
    bookRecheck(svc);
    expect(await ask(svc, 'when is my next appointment?')).toBe(
      'Your next booked appointment is your BP recheck with Dr. Priya Lee on Thursday, Nov 12 at 1:30 p.m. '
      + 'After that, your annual physical with Dr. Priya Lee on Thursday, Jan 14, 2027 at 9:30 a.m.',
    );
    expect(await ask(svc, 'what have I asked you for so far?')).toMatch(/Already handled by staff:\n- Your BP recheck with Dr\. Priya Lee: booked for Thursday, Nov 12 at 1:30 p\.m\./);
  });

  it('staff can text Alex the update; it is saved as a clinic message, not an agent reply', async () => {
    const svc = await setup();
    const text = draftUpdate(svc.store.getRequest(1)!, 'booked', { date: '2026-11-12', time: '13:30', provider: 'Dr. Priya Lee' });
    expect(text).toBe('Hi Alex, your BP recheck with Dr. Priya Lee is booked for Thursday, Nov 12 at 1:30 p.m. Reply here if you need to change it. – Sapling Family Clinic');
    bookRecheck(svc, text);
    const last = svc.store.listMessages(pid).at(-1)!;
    expect(last).toMatchObject({ author: 'clinic', direction: 'outbound', body: text });
  });

  it('"move the recheck to Friday" after it was booked asks staff to move that booking', async () => {
    const svc = await setup();
    bookRecheck(svc);
    expect(await ask(svc, 'can we move the recheck to Friday?')).toMatch(/asked the clinic staff to move your BP recheck .* Thursday, Nov 12 at 1:30 p\.m\. to Friday, Nov 6/);
    const change = svc.store.listRequests(pid).find((r) => r.type === 'appointment_change')!;
    resolveRequest(svc, change.id, { outcome: 'done', date: '2026-11-13', time: '10:00' });
    expect(await ask(svc, 'when is my next appointment?')).toMatch(/^Your next booked appointment is your BP recheck with Dr\. Priya Lee on Friday, Nov 13 at 10:00 a\.m\./);
  });

  it('a cancellation staff carried out removes the physical from upcoming visits', async () => {
    const svc = await setup();
    await svc.receivePatientMessage('I need to cancel my physical');
    const change = svc.store.listRequests(pid).find((r) => r.type === 'appointment_change')!;
    resolveRequest(svc, change.id, { outcome: 'done' });
    expect(await ask(svc, 'when is my next appointment?')).toMatch(/^You don't have any booked appointments on file\./);
  });
});

describe('a visit staff could not book', () => {
  it('offers to request it again, and "yes" starts a new request without asking the reason', async () => {
    const svc = await setup();
    resolveRequest(svc, 1, { outcome: 'not_booked', note: 'Dr. Lee out that week' });
    expect(await ask(svc, 'is it booked yet?')).toMatch(/^Clinic staff weren't able to book your BP recheck for Thursday, Nov 12, in the afternoon\. Would you like me to request it again/);
    expect(await ask(svc, 'yes')).toMatch(/What day and time work best/);
    await svc.receivePatientMessage('Tuesday afternoon works');
    expect(svc.store.listRequests(pid).filter((r) => r.type === 'appointment_request').map((r) => r.status)).toEqual(['completed', 'pending_staff']);
  });

  it("never repeats staff's internal note to Alex", async () => {
    const svc = await setup();
    resolveRequest(svc, 1, { outcome: 'not_booked', note: 'Dr. Lee out that week' });
    for (const q of ['is it booked yet?', 'what have I asked you for so far?']) expect(await ask(svc, q)).not.toMatch(/out that week/);
  });
});

describe('refills', () => {
  it('a status question while pending says "not yet" and files nothing new', async () => {
    const svc = await setup();
    expect(await ask(svc, 'has my refill been approved?')).toMatch(/^Not yet\. Your refill request for Lisinopril 10 mg is pending staff review/);
    expect(svc.store.listRequests(pid).filter((r) => r.type === 'refill')).toHaveLength(1);
  });

  it('after staff approve it, reports the approval instead of filing a second refill', async () => {
    const svc = await setup();
    resolveRequest(svc, 2, { outcome: 'approved' });
    expect(await ask(svc, 'has my refill been approved?')).toMatch(/^Yes\. Clinic staff approved your refill of Lisinopril 10 mg\./);
    expect(svc.store.listRequests(pid).filter((r) => r.type === 'refill')).toHaveLength(1);
  });

  it('after staff deny it, says so and points to the phone line', async () => {
    const svc = await setup();
    resolveRequest(svc, 2, { outcome: 'denied' });
    expect(await ask(svc, 'did my refill go through?')).toMatch(/couldn't approve your refill .* call the clinic at \(555\) 010-0100/);
  });
});

describe('the staff action validates its input', () => {
  const code = (fn: () => void) => { try { fn(); } catch (e) { return (e as ResolveError).status; } return 200; };
  it.each([
    ['an unknown request', 99, { outcome: 'booked' }, 404],
    ['an outcome that does not fit the type', 2, { outcome: 'booked' }, 400],
    ['booked without a date', 1, { outcome: 'booked', time: '13:30' }, 400],
    ['booked without a valid time', 1, { outcome: 'booked', date: '2026-11-12', time: '1:30pm' }, 400],
  ])('rejects %s', async (_, id, input, status) => {
    const svc = await setup();
    expect(code(() => resolveRequest(svc, id, input))).toBe(status);
  });

  it('refuses to resolve the same request twice', async () => {
    const svc = await setup();
    bookRecheck(svc);
    expect(code(() => bookRecheck(svc))).toBe(409);
  });

  it('survives a restart', async () => {
    const file = tempDbFile();
    let svc = openService(file);
    svc.sendClinicMessage(SCRIPT[0].body);
    for (const n of [1, 2]) await svc.receivePatientMessage(SCRIPT[n].body);
    resolveRequest(svc, 1, { outcome: 'booked', date: '2026-11-10', time: '14:00' });
    svc.store.close();
    svc = openService(file);
    expect(await ask(svc, 'is it booked yet?')).toMatch(/Tuesday, Nov 10 at 2:00 p\.m\./);
  });
});

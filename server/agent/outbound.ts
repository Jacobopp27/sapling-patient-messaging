// Clinic-authored outbound messages are read once when sent, so a later "yes" from Alex can be
// matched to what the clinic actually offered (step 0 → step 1). Staff text is trusted input.
import type { Patient } from '../data.js';
import type { Pending } from '../types.js';

export function pendingFromClinicMessage(body: string, patient: Patient): Pending | undefined {
  const aboutVisit = /\b(recheck|follow[- ]?up|appointment|visit|come in)\b/i.test(body);
  const asksPatient = /\b(would you like|do you want|want us to|shall we|should we)\b/i.test(body);
  if (!aboutVisit || !asksPatient) return undefined;

  const reason = /\b(blood pressure|bp)\b/i.test(body) && /\b(re)?check\b/i.test(body) ? 'BP recheck' : 'follow-up visit';
  const lastName = body.match(/\bDr\.?\s+([A-Z][a-z]+)/)?.[1];
  const known = [patient.last_visit.provider, ...patient.upcoming_appointments.map((a) => a.provider)];
  const provider = known.find((p) => lastName && p.endsWith(lastName)) ?? patient.last_visit.provider;
  const lv = patient.last_visit;
  return {
    kind: 'appointment_offer',
    reason,
    provider,
    context: `Clinic outreach. Last visit ${lv.date} with ${lv.provider} (${lv.reason}); plan note: "${lv.plan_note}"`,
  };
}

// Read-only access to the supplied synthetic data. Nothing in the app writes these files.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const besideServer = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
/** data/ next to server/; on a serverless bundle, the copy shipped at the project root. */
export const DATA_DIR = existsSync(besideServer) ? besideServer : path.join(process.cwd(), 'data');

export interface Medication { name: string; dose: string; frequency: string; refills_remaining: number }
export interface Appointment { date: string; time: string; provider: string; type: string; status: string }
export interface Patient {
  patient_id: string;
  name: string;
  preferred_name: string;
  date_of_birth: string;
  language: string;
  phone: string;
  conditions: string[];
  medications: Medication[];
  pharmacy: string;
  insurance: { payer: string; plan: string };
  last_visit: { date: string; provider: string; reason: string; plan_note: string };
  upcoming_appointments: Appointment[];
  balance: { amount: number; reason: string };
}
export interface Slot { date: string; start: string; provider: string }

/** FAQ entries keyed by their bold label, lowercased: "hours", "paying a balance", ... */
export type Faq = Record<string, string>;

export interface ClinicData { patient: Patient; faq: Faq; slots: Slot[] }

/**
 * Structured copy of the FAQ "Hours" line so we can answer "do you close today?".
 * tests/data.test.ts fails if the FAQ text and this drift apart.
 */
export const BUSINESS_HOURS = { days: [1, 2, 3, 4, 5], open: '09:00', close: '17:00' };

export function parseFaq(markdown: string): Faq {
  const faq: Faq = {};
  for (const line of markdown.split('\n')) {
    const m = line.match(/^- \*\*(.+?):\*\*\s*(.+)$/);
    if (m) faq[m[1].toLowerCase()] = m[2].trim();
  }
  return faq;
}

export function loadClinicData(dir = DATA_DIR): ClinicData {
  const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');
  return {
    patient: JSON.parse(read('alex_morgan.json')),
    faq: parseFaq(read('clinic_faq.md')),
    slots: JSON.parse(read('open_slots.json')),
  };
}

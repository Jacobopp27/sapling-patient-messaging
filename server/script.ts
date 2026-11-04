// The Phase 1 scenario script, as data. Used by tests/script.test.ts, scripts/run-script.ts and the
// UI's "Run script" button, so all three exercise exactly the same inputs.

export interface ScriptStep { step: number; author: 'clinic' | 'patient'; body: string; restartBefore?: boolean }

export const SCRIPT: ScriptStep[] = [
  { step: 0, author: 'clinic', body: 'Hi Alex, this is Sapling Family Clinic. Dr. Lee asked to recheck your blood pressure about 4 weeks after your Oct 6 visit. Would you like us to request a time for you? Reply here anytime.' },
  { step: 1, author: 'patient', body: 'yes' },
  { step: 2, author: 'patient', body: 'Tuesday afternoon works' },
  { step: 3, author: 'patient', body: 'actually can we do Thursday instead' },
  { step: 4, author: 'patient', body: 'is it booked yet?' },
  { step: 5, author: 'patient', body: 'when is my next appointment?' },
  { step: 6, author: 'patient', body: 'what time do you close today?' },
  { step: 7, author: 'patient', body: 'do you take Aetna?' },
  { step: 8, author: 'patient', body: 'can I get a refill on my BP med' },
  { step: 9, author: 'patient', body: 'my readings have been around 150/95 all week, should I take two pills?' },
  { step: 10, author: 'patient', body: 'why do I owe $40?' },
  { step: 11, author: 'patient', body: 'I have chest pain and my left arm feels numb' },
  { step: 12, author: 'patient', body: 'what have I asked you for so far?', restartBefore: true },
];

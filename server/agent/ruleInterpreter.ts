// Local, deterministic interpreter: keyword and regex rules, no network, no API key.
// It is the default mode and the test double for the Claude interpreter (same interface).
// Order matters: clinical and refill checks run before scheduling words so "should I take two
// pills" is never treated as anything but a clinical question.
import { WEEKDAYS } from '../clock.js';
import type { Intent, Interpretation, Interpreter, InterpreterContext } from './interpretation.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAY_RE = /\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|nesday|rsday|urday)?\b/i;

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

function extractWeekday(text: string): string | undefined {
  const m = text.match(WEEKDAY_RE);
  if (m) {
    const prefix = m[1].toLowerCase().slice(0, 3);
    return WEEKDAYS.find((d) => d.startsWith(prefix));
  }
  // Typos ("thursdar", "wensday", "tuesdy"): a word one edit from a weekday name (two for longer
  // words), with the same first letter, and close to only one day. "sunny" and "wedding" don't match.
  for (const word of text.toLowerCase().match(/[a-z]{5,}/g) ?? []) {
    const allowed = word.length >= 7 ? 2 : 1;
    const close = WEEKDAYS.filter((d) => d[0] === word[0] && editDistance(word, d) <= allowed);
    if (close.length === 1) return close[0];
  }
  return undefined;
}

function extractTime(text: string): string | undefined {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase().startsWith('p')) h += 12;
    return `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`;
  }
  // "at 1:30" or "1:30" with no a.m./p.m.: read it inside clinic hours (9–11 → morning, 12–5 → afternoon).
  const bare = text.match(/\bat (\d{1,2})(?::(\d{2}))?\b(?!\s*\/)/i) ?? text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!bare) return undefined;
  const h = Number(bare[1]);
  if (h >= 1 && h <= 5) return `${String(h + 12).padStart(2, '0')}:${bare[2] ?? '00'}`;
  if (h >= 9 && h <= 12) return `${String(h).padStart(2, '0')}:${bare[2] ?? '00'}`;
  return undefined;
}

function extractDate(text: string, today: string): string | undefined {
  const named = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i);
  const numeric = text.match(/\b(\d{1,2})\/(\d{1,2})\b(?!\s*\/|\d)/);
  let month: number | undefined, day: number | undefined;
  if (named) { month = MONTHS.indexOf(named[1].toLowerCase().slice(0, 3)) + 1; day = Number(named[2]); }
  else if (numeric && !/\d{2,3}\/\d{2,3}/.test(numeric[0])) { month = Number(numeric[1]); day = Number(numeric[2]); }
  if (!month || !day || month > 12 || day > 31) return undefined;
  let year = Number(today.slice(0, 4));
  const iso = (y: number) => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (iso(year) <= today) year += 1;
  return iso(year);
}

function extractWindow(text: string): 'morning' | 'afternoon' | undefined {
  if (/\bmorning\b/i.test(text)) return 'morning';
  if (/\bafternoon\b|\bevening\b|after lunch|\bpm\b|\bp\.m\./i.test(text)) return 'afternoon';
  if (/\ba\.m\./i.test(text)) return 'morning';
  return undefined;
}

const READING_RE = /\b(\d{2,3})\s*\/\s*(\d{2,3})\b/g;

/** Words that name a booked appointment on file: "Annual physical" → annual, physical. */
function bookedWords(ctx: InterpreterContext): RegExp | undefined {
  const words = ctx.appointmentTypes.flatMap((t) => t.toLowerCase().split(/\W+/)).filter((w) => w.length > 3);
  return words.length ? new RegExp(`\\b(${words.join('|')})\\b`, 'i') : undefined;
}

/** For change_appointment: which appointment the text names, if any. */
export function changeTarget(text: string, ctx: InterpreterContext): 'booked' | 'request' | undefined {
  if (bookedWords(ctx)?.test(text)) return 'booked';
  if (/\b(recheck|request|bp (visit|appointment|check))\b/i.test(text)) return 'request';
  return undefined;
}

/** "I can't at 3:30", "Tuesday doesn't work", "I'm busy Thursday": a day or time ruled out. */
const RULES_OUT = /\b(can'?t|cannot|can not|won'?t|wont|unable|busy|(doesn'?t|does not|won'?t|wouldn'?t) work|not (good|available|possible))\b/i;

function schedulingFields(t: string, today: string): Partial<Interpretation> {
  const weekday = extractWeekday(t);
  const date = extractDate(t, today);
  const time = extractTime(t);
  const window = extractWindow(t);
  const tomorrow = /\btomorrow\b/i.test(t);
  if (RULES_OUT.test(t) && (time || weekday)) return time ? { avoid_time: time } : { avoid_weekday: weekday };
  return {
    ...(weekday ? { weekday } : {}),
    ...(date ? { date } : {}),
    ...(time ? { time } : {}),
    ...(window ? { window } : {}),
    ...(tomorrow && !date ? { topic: 'tomorrow' } : {}),
  };
}

// Intents that don't count as "something else" in a multi-part message.
const MINOR: Intent[] = ['unknown', 'affirm', 'decline', 'thanks'];
const SCHEDULING: Intent[] = ['appointment_preference', 'change_appointment'];

/**
 * The local interpreter handles one intent per message. It still reads each sentence (and each
 * "also ..." part) on its own, so a second request isn't dropped silently: the agent tells Alex.
 */
export function interpretWithRules(ctx: InterpreterContext): Interpretation {
  const main = interpretOne(ctx);
  const parts = ctx.text.split(/(?<=[.?!])\s+|\s*\b(?:and also|also|plus)\b\s*/i).filter((p) => p.trim().length > 2);
  if (parts.length < 2) return main;
  const same = (x: Intent) => x === main.intent || (SCHEDULING.includes(x) && SCHEDULING.includes(main.intent));
  const also = [...new Set(parts.map((p) => interpretOne({ ...ctx, text: p }).intent))].filter((x) => !MINOR.includes(x) && !same(x));
  return also.length ? { ...main, also } : main;
}

function interpretOne(ctx: InterpreterContext): Interpretation {
  const t = ctx.text.trim();
  const lower = t.toLowerCase();

  // Clinical: readings, symptoms, or any "should I / can I take / is it safe" about health or meds.
  const readings = [...t.matchAll(READING_RE)].map((m) => `${m[1]}/${m[2]}`).filter((r) => Number(r.split('/')[0]) >= 60);
  const clinical = readings.length > 0
    || /\bshould i\b|\bis it (safe|ok|okay|normal)\b|\b(take|taking|double|skip|stop|increase|lower)\b.{0,25}\b(pills?|dose|doses|tablets?|meds?|medication|lisinopril)\b/i.test(t)
    || /\b(dizzy|dizziness|headache|side effects?|symptoms?|swelling|cough|rash|nausea|fever|hurts?|pain)\b/i.test(t);
  if (clinical) {
    const period = lower.match(/\b(all week|this week|for (?:a|the past|the last)? ?(?:few )?(?:days?|weeks?)|every day|lately|since \w+)\b/)?.[0];
    return { intent: 'clinical_question', readings, ...(period ? { period } : {}) };
  }

  const named = ctx.medications.find((m) => lower.includes(m.toLowerCase()));
  const meds = `(meds|medications?|medicine|pills|prescription${named ? `|${named.toLowerCase()}` : ''})`;
  if (/\b(refill|renew)\b/i.test(t)
    || new RegExp(`\\b(run(ning)? (out|low)|almost out|nearly out|out of)\\b(\\s+\\w+){0,4}?\\s+${meds}\\b|\\b(need|want|get) (more|some more)\\b(\\s+\\w+){0,3}?\\s+${meds}\\b`, 'i').test(t)) {
    return { intent: 'refill', ...(named ? { medication: named } : {}) };
  }

  // Moving or cancelling an appointment. Checked before the status and FAQ rules, so "move my next
  // appointment" isn't read as a question, and "cancel my physical" files a request instead of
  // only quoting the cancellation policy.
  const cancel = /\b(cancel|call off|can'?t make it|cannot make it|won'?t make it|(don'?t|no longer) need|never ?mind)\b/i.test(t);
  if ((cancel || /\b(move|reschedule|change|push|switch)\b/i.test(t))
    && (changeTarget(t, ctx) || /\b(appointment|visit|it|that)\b/i.test(t))) {
    const target = changeTarget(t, ctx);
    return { intent: 'change_appointment', action: cancel ? 'cancel' : 'reschedule', ...(target ? { target } : {}), ...schedulingFields(t, ctx.today) };
  }

  if (/\bwhat (have|did) i ask|\basked (you )?(for )?so far\b|\bmy (open |pending )?requests\b|\bwhat('s| is) pending\b/i.test(t)) {
    return { intent: 'list_requests' };
  }

  if (/\b(is|was|has) (it|that|this|my \w+)( been)? (booked|confirmed|scheduled|set|approved)\b|\bbooked yet\b|\bstatus of my\b|\bany update\b|\bdid (you|they|someone|anyone|the clinic) (book|schedule|confirm)\b/i.test(t)) {
    return { intent: 'appointment_status' };
  }

  if (/\b(next|upcoming) (appointment|appt|visit)\b|\bwhen'?s my\b|\bwhen is my (appointment|appt|visit|physical)\b|\bdo i have (an|any) (appointments?|appts?)\b/i.test(t)) {
    return { intent: 'next_appointment' };
  }

  // Questions about Alex's own record.
  const record: [string, RegExp][] = [
    ['provider', /\bwho('s| is) my (doctor|provider|pcp|physician)\b|\bmy (doctor|provider|pcp)'?s name\b/i],
    ['medications', /\bwhat (medications?|meds|medicine|pills) (am i|do i)\b|\b(list|which) (of )?my (medications|meds)\b/i],
    ['pharmacy', /\b(which|what) pharmacy\b|\bmy pharmacy\b/i],
    ['insurance', /\bwhat insurance do i have\b|\bmy insurance (on file|plan)\b|\binsurance (do you have )?on file\b/i],
  ];
  for (const [topic, re] of record) if (re.test(t)) return { intent: 'record_info', topic };

  if (/\b(do|does) (you|the clinic) (take|accept)\b|\bin[- ]network\b|\b(accept|take)\b.{0,20}\binsurance\b|\b(aetna|cigna|kaiser|medicare|medicaid|united ?health(care)?|humana)\b/i.test(t)) {
    return { intent: 'not_in_data', topic: 'which insurance plans the clinic accepts' };
  }

  if (/\b(dispute|wrong charge|overcharged|refund|payment plan|already paid)\b/i.test(t)) return { intent: 'billing_issue' };
  if (/\b(owe|balance|bill|copay|co-pay|charge)\b|\$\s?\d/i.test(t)) {
    return /\bhow (do|can) i pay\b|\bwhere (do|can) i pay\b/i.test(t) ? { intent: 'clinic_info', topic: 'paying a balance' } : { intent: 'balance' };
  }
  if (/\b(can|could|how do|how can) i pay\b|\bpay(ment)? (online|by card|with a card)\b/i.test(t)) return { intent: 'clinic_info', topic: 'paying a balance' };

  const faqTopic: [string, RegExp][] = [
    ['hours', /\b(close|closing|open|opening|hours)\b/i],
    ['address', /\b(address|where are you|located|location|parking|park)\b/i],
    ['phone', /\b(phone number|call you|number to call)\b/i],
    ['what to bring', /\b(bring|need to have)\b/i],
    ['cancellations', /\b(cancel|cancellation)\b/i],
    ['texting', /\b(text(s|ing)? (line|monitored)|reply fast)\b/i],
  ];
  for (const [topic, re] of faqTopic) {
    // "Are you open on Saturday?" carries the day, so the answer is about that day.
    if (re.test(t)) return { intent: 'clinic_info', topic, ...(topic === 'hours' ? schedulingFields(t, ctx.today) : {}) };
  }

  const when = schedulingFields(t, ctx.today);
  if (Object.keys(when).length || /\b(appointment|book|schedule|reschedule|come in|recheck|visit)\b/i.test(t)) {
    return { intent: 'appointment_preference', ...when };
  }

  if (/^(yes|yeah|yep|yup|sure|ok|okay|please|please do|sounds good|y|si|sí)\b/i.test(t)) return { intent: 'affirm' };
  if (/^(no|nope|nah|no thanks|not now)\b/i.test(t)) return { intent: 'decline' };
  if (/\b(thanks|thank you|thx|ty)\b/i.test(t)) return { intent: 'thanks' };
  return { intent: 'unknown' };
}

export const ruleInterpreter: Interpreter = {
  name: 'rules',
  interpret: async (ctx) => interpretWithRules(ctx),
};

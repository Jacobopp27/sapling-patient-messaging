// Intent handlers: plain code that reads data through tools, files requests, and builds the reply
// from templates. Patient-facing safety wording lives here, not in a model prompt.
import { addDays, federalHoliday, formatDate, formatTime, resolveWeekday, weekdayOf, WEEKDAYS, windowOf } from '../clock.js';
import { BUSINESS_HOURS, type Appointment, type Patient } from '../data.js';
import { bookingState } from '../resolutions.js';
import type { AgentTools } from '../tools.js';
import type { Message, Pending, ReplySource, Request } from '../types.js';
import type { Interpretation, Intent } from './interpretation.js';

export interface Turn {
  tools: AgentTools;
  inbound: Message;
  /** What the previous outbound message was waiting for, and that message's id. */
  pending?: Pending;
  pendingMessageId?: number;
  /** For an appointment_reason follow-up: Alex's text is the reason. */
  reasonOverride?: string;
  /** The clinic's latest appointment offer still waiting for a request, even if other replies came after it. */
  openOffer?: { pending: Pending; messageId: number };
}

export interface HandlerResult { body: string; source: ReplySource; pending?: Pending }

/** Add a full stop unless the text already ends with one (e.g. "3:30 p.m."). */
const endSentence = (s: string) => (s.endsWith('.') ? s : `${s}.`);

const NOT_MONITORED = "Texts are read during business hours and aren't monitored continuously.";

/** "Dr. Priya Lee" → "Dr. Lee" */
const shortName = (provider: string) => provider.replace(/^(Dr\.)\s+\S+\s+/, '$1 ');

const windowText = (w: unknown) => (w === 'any' || !w ? 'any time that day' : `in the ${w}`);

function slotList(times: string[]): string {
  const t = times.map(formatTime);
  return t.length <= 1 ? t.join('') : `${t.slice(0, -1).join(', ')} or ${t.at(-1)}`;
}

function describeAppointmentRequest(r: Request, today: string): string {
  const d = r.details;
  return `${d.reason} with ${d.provider} on ${formatDate(String(d.date), today)}, ${windowText(d.window)}`;
}

/** "Veterans Day" or "weekends" when the clinic is closed on that date (FAQ: closed weekends and federal holidays). */
function closedOn(date: string): string | undefined {
  return federalHoliday(date) ?? (BUSINESS_HOURS.days.includes(weekdayOf(date)) ? undefined : 'weekends');
}

/** The clinic is closed that day: say so and ask again, instead of filing a request staff would have to bounce. */
function closedDayReply(turn: Turn, date: string, why: string, provider: string, still?: string): string {
  const today = turn.tools.now().date;
  return `The clinic is closed on ${formatDate(date, today)} (${why}), so I can't request that day.${still ? ` ${still}` : ''} What other day works for you?${openings(turn, provider)}`;
}

/**
 * Booked appointments from today on, soonest first: the record's (as staff moved or cancelled them)
 * plus the visits staff booked from Alex's requests. What staff recorded is the source of truth.
 */
function bookedAppointments(tools: AgentTools): Appointment[] {
  const today = tools.now().date;
  const resolved = tools.requests().filter((r) => r.resolution);
  const changes = resolved.filter((r) => r.type === 'appointment_change' && r.resolution!.outcome === 'done');
  const fromRecord = tools.patient('upcoming_appointments').upcoming_appointments.filter((a) => a.status === 'booked');
  const fromStaff = resolved
    .filter((r) => r.type === 'appointment_request' && r.resolution!.outcome === 'booked' && r.resolution!.appointment)
    .map((r): Appointment => ({ ...r.resolution!.appointment!, type: String(r.details.reason), status: 'booked' }));
  // Follow each visit through the changes staff carried out: moved (maybe more than once) or cancelled.
  const follow = (a: Appointment): Appointment[] => {
    for (let hops = 0; hops < changes.length; hops++) {
      const change = changes.filter((c) => c.details.appointment === appointmentKey(a)).at(-1);
      if (!change) return [a];
      if (change.details.action === 'cancel' || !change.resolution!.appointment) return [];
      const moved = change.resolution!.appointment;
      a = { ...a, date: moved.date, time: moved.time, provider: moved.provider };
    }
    return [a];
  };
  return [...fromRecord, ...fromStaff]
    .flatMap(follow)
    .filter((a) => a.date >= today)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

const appointmentKey = (a: Appointment) => `${a.type} ${a.date} ${a.time}`;

/** "Annual physical" → "annual physical", but "BP recheck" stays. */
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

function describeBooked(a: Appointment, today: string): string {
  return `${lowerFirst(a.type)} with ${a.provider} on ${formatDate(a.date, today)} at ${formatTime(a.time)}`;
}

/** The booked appointment Alex names ("my physical", "the recheck"), if any. */
function mentionedAppointment(text: string, booked: Appointment[]): Appointment | undefined {
  const lower = text.toLowerCase();
  return booked.find((a) => a.type.toLowerCase().split(/\W+/).some((w) => w.length > 3 && lower.includes(w)));
}

// --- appointments -----------------------------------------------------------

function openings(turn: Turn, provider: string, skip: { weekday?: string } = {}): string {
  const { tools } = turn;
  const byDate = new Map<string, string[]>();
  for (const s of tools.openSlots({ provider })) {
    if (skip.weekday && WEEKDAYS[weekdayOf(s.date)] === skip.weekday) continue;
    byDate.set(s.date, [...(byDate.get(s.date) ?? []), s.start]);
  }
  const today = tools.now().date;
  const options = [...byDate].map(([date, times]) => `${formatDate(date, today)} (${slotList(times)})`);
  return options.length ? ` ${shortName(provider)} currently has openings on ${options.join(' and ')}.` : '';
}

/**
 * Alex's answer to "What's the visit for?" as a short visit reason staff can read, not the whole sentence:
 * "I need to check my blood pressure." → "BP check"; "To recheck my BP" → "BP recheck";
 * "I'd like a flu shot" → "flu shot"; "I want to talk about my knee" → "visit to talk about my knee".
 */
export function asReason(text: string): string {
  let t = text.trim().replace(/[.!?]+$/, '').trim();
  const lead = [
    /^(so|well|um+|uh+|yeah|yes|ok(ay)?|hi|hello)\b,?\s*/i, // filler
    /^(i|we)\s*(really\s+)?(need|want|wanna|would like|'d like|have|was hoping|am hoping|'m hoping)\s*/i, // "I need", "I'd like"
    /^(i'?m|i am)\s+(calling|coming in|writing)\s*/i,
    /^(it'?s|it is|the visit is|that'?s|this is)\s*/i,
    /^(to\s+)?(make|book|schedule|get|have)\s+(an?\s+)?(appointment|visit)\s*/i, // "to book an appointment for …"
  ];
  for (let changed = true; changed;) {
    changed = false;
    for (const re of lead) if (re.test(t)) { t = t.replace(re, ''); changed = true; }
  }
  // Blood pressure visits get the clinic's own name for them.
  if (/\b(pressure|bp)\b/i.test(t) && /\b(re-?check|follow[- ]?up|check|monitor|look at|test|reading)/i.test(t)) {
    return /\bre-?check|follow[- ]?up/i.test(t) ? 'BP recheck' : 'BP check';
  }
  const verb = t.match(/^to\s+(.+)/i);
  if (verb) return `visit to ${verb[1]}`;
  t = t.replace(/^(for|about)\s+/i, '').replace(/^(an?|the)\s+/i, '');
  if (/^(check|see|talk|discuss|get|have|look|follow|review|renew|update)\b/i.test(t)) return `visit to ${t}`;
  return t || text.trim();
}

/** "a BP recheck", "an annual physical", "a visit to …". */
function withArticle(noun: string): string {
  return /^(an?|the)\s/i.test(noun) ? noun : `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

function askForTime(turn: Turn, reason: string, provider: string, context: string | undefined, sourceMessageIds: number[]): HandlerResult {
  return {
    body: `Great, I'll request ${withArticle(reason)} with ${provider} for you. What day and time work best for you?${openings(turn, provider)}`,
    source: 'open_slots',
    pending: { kind: 'appointment_time', reason, provider, context, sourceMessageIds },
  };
}

type Offer = Extract<Pending, { kind: 'appointment_offer' | 'appointment_time' }>;
const asOffer = (p?: Pending): Offer | undefined => (p?.kind === 'appointment_offer' || p?.kind === 'appointment_time' ? p : undefined);

/** "Tuesday, Nov 10 (2:00 p.m. or 3:30 p.m.) and Thursday, Nov 12 (…)" */
function slotsByDay(slots: { date: string; start: string }[], today: string): string {
  const byDate = new Map<string, string[]>();
  for (const s of slots) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s.start]);
  return [...byDate].map(([date, times]) => `${formatDate(date, today)} (${slotList(times)})`).join(' and ');
}

/**
 * "Any openings on Monday?", "is this week available?": a question, not a request. Answer from the
 * open slots and file nothing; the time Alex then picks becomes the request.
 */
function availabilityQuestion(turn: Turn, i: Interpretation): HandlerResult {
  const { tools, pending, inbound } = turn;
  const today = tools.now().date;
  const existing = tools.openRequests('appointment_request').at(-1);
  const fromLast = asOffer(pending);
  const offer = fromLast ?? asOffer(turn.openOffer?.pending);
  const offerMessageId = fromLast ? turn.pendingMessageId : turn.openOffer?.messageId;
  const provider = (existing?.details.provider as string | undefined) ?? offer?.provider ?? tools.patient('last_visit').last_visit.provider;
  const doc = shortName(provider);

  // Which days the question is about: one day, this or next week, or anything open.
  let days: string[] | undefined;
  let label = '';
  if (i.date || i.weekday || i.topic === 'tomorrow') {
    const date = i.date ?? (i.topic === 'tomorrow' ? addDays(today, 1) : resolveWeekday(today, WEEKDAYS.indexOf(i.weekday!)));
    days = [date];
    label = `on ${formatDate(date, today)}`;
  } else if (i.week) {
    const anchor = i.week === 'this' ? today : i.week === 'next' ? addDays(today, 7) : i.week;
    const monday = addDays(anchor, -((weekdayOf(anchor) + 6) % 7));
    days = [];
    for (let d = monday > today ? monday : addDays(today, 1); d <= addDays(monday, 6); d = addDays(d, 1)) days.push(d);
    label = i.week === 'this' ? 'for the rest of this week' : i.week === 'next' ? 'next week' : `the week of ${formatDate(monday, today)}`;
  }

  const all = tools.openSlots({ provider, window: i.window ?? 'any' });
  const matching = days ? all.filter((s) => days!.includes(s.date)) : all;
  // Keep the clinic's offer going, so "Tuesday 2pm works" next becomes the BP recheck request.
  const sources = offer?.kind === 'appointment_time' ? offer.sourceMessageIds ?? [] : offer && offerMessageId ? [offerMessageId] : [];
  const keepOffer: Pending | undefined = offer && !existing
    ? { kind: 'appointment_time', reason: offer.reason, provider, context: offer.context, sourceMessageIds: [...sources, inbound.id] }
    : undefined;

  const closed = days?.length === 1 ? closedOn(days[0]) : undefined;
  let body: string;
  if (closed) {
    body = `The clinic is closed ${label} (${closed}).${all.length ? ` ${doc}'s next openings are ${slotsByDay(all, today)}.` : ''}`;
  } else if (matching.length) {
    body = days?.length === 1
      ? `Yes. ${doc} has openings ${label}: ${slotList(matching.map((s) => s.start))}.`
      : `${doc} has openings ${label ? `${label}: ` : 'on '}${slotsByDay(matching, today)}.`;
  } else {
    body = `${doc} doesn't have open times ${label || 'right now'}.${all.length ? ` The next openings are ${slotsByDay(all, today)}.` : ''}`;
  }
  body += matching.length || all.length
    ? ' Which works for you? You can also name another day, and staff will look for options.'
    : ' Tell me a day that works, and staff will look for options.';
  return { body: body.replace(/p\.m\.\./g, 'p.m.').replace(/a\.m\.\./g, 'a.m.'), source: 'open_slots', pending: keepOffer };
}

function appointmentPreference(turn: Turn, i: Interpretation): HandlerResult {
  const { tools, inbound, pending } = turn;
  const patient = tools.patient('last_visit');
  const today = tools.now().date;
  const existing = tools.openRequests('appointment_request').at(-1);
  // What the last message offered, or else the clinic's offer still open further up the thread.
  const fromLast = asOffer(pending);
  const offer = fromLast ?? asOffer(turn.openOffer?.pending);
  const offerMessageId = fromLast ? turn.pendingMessageId : turn.openOffer?.messageId;
  const fromReasonPrompt = pending?.kind === 'appointment_reason' ? pending : undefined;

  // A reason Alex gave in this message ("I need my blood pressure rechecked. Tuesday works.") counts
  // too, after the request's and the clinic offer's: those are the clinic's own words.
  const reason = turn.reasonOverride ?? (existing?.details.reason as string | undefined) ?? offer?.reason
    ?? (i.reason ? asReason(i.reason) : undefined);
  const provider = (existing?.details.provider as string | undefined) ?? offer?.provider ?? patient.last_visit.provider;
  const context = (existing?.details.context as string | undefined) ?? offer?.context;
  // Link the clinic's offer (and Alex's "yes") to the request, so staff see where it came from.
  const priorSources = offer?.kind === 'appointment_time' ? offer.sourceMessageIds ?? []
    : offer && offerMessageId ? [offerMessageId] : [];

  if (i.avoid_time || i.avoid_weekday) {
    return ruleOut(turn, i, { existing, reason, provider, context, sources: [...priorSources, inbound.id] });
  }

  const time = i.time ?? fromReasonPrompt?.time;
  let date = i.date ?? (i.topic === 'tomorrow' ? addDays(today, 1) : undefined);
  // Answering the clinic's offer, "Thursday" means the Thursday with openings (Nov 12, the one we
  // list), not tomorrow, which has none. The date is said back, so Alex can correct it.
  if (!date && i.weekday && ((!existing && offer) || (existing && !existing.details.date))) {
    date = tools.openSlots({ provider }).find((s) => weekdayOf(s.date) === WEEKDAYS.indexOf(i.weekday!))?.date;
  }
  if (!date && i.weekday) date = resolveWeekday(today, WEEKDAYS.indexOf(i.weekday), existing?.details.date as string | undefined);
  date ??= fromReasonPrompt?.date ?? (existing?.details.date as string | undefined);
  const window = i.window ?? (time ? windowOf(time) : undefined) ?? fromReasonPrompt?.window ?? (existing?.details.window as string | undefined);

  if (!reason) {
    return {
      body: "I can request an appointment for you. What's the visit for?",
      source: 'clarifying',
      pending: { kind: 'appointment_reason', date, window, time },
    };
  }
  if (!date) return askForTime(turn, reason, provider, context, [...priorSources, inbound.id]);

  const closed = closedOn(date);
  if (closed) {
    const still = existing ? `Your ${reason} request is still for ${formatDate(String(existing.details.date), today)}, ${windowText(existing.details.window)}.` : undefined;
    return {
      body: closedDayReply(turn, date, closed, provider, still),
      source: 'clarifying',
      pending: { kind: 'appointment_time', reason, provider, context, sourceMessageIds: [...priorSources, inbound.id] },
    };
  }

  const finalWindow = (window ?? 'any') as 'morning' | 'afternoon' | 'any';
  // Times Alex ruled out on this day stay ruled out.
  const avoidTimes = existing && existing.details.date === date ? (existing.details.avoid_times as string[] | undefined) ?? [] : [];
  const slots = tools.openSlots({ date, window: finalWindow, provider }).map((s) => s.start).filter((t) => !avoidTimes.includes(t));
  // Alex picked one of the open times: that's the one, not the whole list.
  const picked = time !== undefined && slots.includes(time);
  tools.upsertRequest('appointment_request', {
    reason, provider, date, window: finalWindow,
    preferred_time: time,
    matching_open_slots: picked ? [time] : slots,
    avoid_times: avoidTimes.length ? avoidTimes : undefined,
    context,
  }, [...priorSources, inbound.id]);

  const when = `${formatDate(date, today)}, ${time ? `${picked ? 'at' : 'around'} ${formatTime(time)}` : windowText(finalWindow)}`;
  const slotText = picked
    ? ` That's one of ${shortName(provider)}'s open times.`
    : slots.length
      ? ` ${endSentence(`Open times then: ${slotList(slots)}`)}`
      : ` I don't see an open time with ${provider} then, so staff will review options with your preference in mind.`;
  const body = existing
    ? `Updated: your ${reason} request is now for ${when}, with ${provider}.${slotText} It's still one request, and it's still pending staff review, not booked. ${NOT_MONITORED}`
    : `Got it. I've requested ${withArticle(reason)} with ${provider} for ${endSentence(when)}${slotText} This is a request, not a booking: it's pending staff review. ${NOT_MONITORED}`;
  return { body, source: 'staff_handoff' };
}

const dayName = (weekday: string) => weekday.replace(/^./, (c) => c.toUpperCase());

/**
 * "I can't at 3:30" / "Tuesday doesn't work": Alex rules something out. It's recorded for staff and
 * never turned into a preference (before, "can't at 3:30" moved the request to 3:30).
 */
function ruleOut(turn: Turn, i: Interpretation, c: {
  existing?: Request; reason?: string; provider: string; context?: string; sources: number[];
}): HandlerResult {
  const { tools } = turn;
  const today = tools.now().date;
  const { existing, reason, provider, context, sources } = c;
  const askAgain = (lead: string, skip: { weekday?: string } = {}): HandlerResult => ({
    body: `${lead} What day and time work best for you?${openings(turn, provider, skip)}`,
    source: 'clarifying',
    pending: reason ? { kind: 'appointment_time', reason, provider, context, sourceMessageIds: sources } : undefined,
  });

  if (i.avoid_weekday) {
    const day = dayName(i.avoid_weekday);
    if (!existing) return askAgain(`Okay, not ${day}.`, { weekday: i.avoid_weekday });
    const d = existing.details;
    const avoidDays = [...new Set([...((d.avoid_days as string[] | undefined) ?? []), i.avoid_weekday])];
    if (d.date && WEEKDAYS[weekdayOf(String(d.date))] === i.avoid_weekday) {
      // Take the day off the request, so staff see "missing date" instead of a day Alex can't do.
      tools.upsertRequest('appointment_request', {
        reason: d.reason, avoid_days: avoidDays, date: undefined, preferred_time: undefined, matching_open_slots: undefined,
      }, sources);
      return askAgain(`Okay, ${day} doesn't work, so I've taken it off your ${d.reason} request.`, { weekday: i.avoid_weekday });
    }
    tools.upsertRequest('appointment_request', { reason: d.reason, avoid_days: avoidDays }, sources);
    return {
      body: `Noted: ${day} doesn't work for you. Your ${d.reason} request is still for ${formatDate(String(d.date), today)}, ${windowText(d.window)}. It's still pending staff review, not booked. ${NOT_MONITORED}`,
      source: 'staff_handoff',
    };
  }

  const t = i.avoid_time!;
  if (!existing) return askAgain(`Okay, not ${formatTime(t)}.`);
  const d = existing.details;
  const date = String(d.date);
  const avoidTimes = [...new Set([...((d.avoid_times as string[] | undefined) ?? []), t])];
  const preferred = d.preferred_time === t ? undefined : (d.preferred_time as string | undefined);
  const slots = tools.openSlots({ date, window: d.window as 'morning' | 'afternoon' | 'any', provider: String(d.provider) })
    .map((s) => s.start).filter((s) => !avoidTimes.includes(s));
  tools.upsertRequest('appointment_request', {
    reason: d.reason,
    preferred_time: preferred,
    avoid_times: avoidTimes,
    matching_open_slots: preferred && slots.includes(preferred) ? [preferred] : slots,
  }, sources);
  const day = formatDate(date, today);
  const rest = preferred
    ? `Your ${d.reason} request stays at ${day} at ${endSentence(formatTime(preferred))}`
    : slots.length
      ? `Your ${d.reason} request is for ${day}, ${windowText(d.window)}. ${endSentence(`The open time${slots.length > 1 ? 's' : ''} left then ${slots.length > 1 ? 'are' : 'is'} ${slotList(slots)}`)}`
      : `I don't see another open time with ${d.provider} then, so staff will review options with that in mind.`;
  return {
    body: `Noted: ${formatTime(t)} doesn't work for you. ${rest} It's still one request, pending staff review, not booked. ${NOT_MONITORED}`,
    source: 'staff_handoff',
  };
}

function appointmentStatus(turn: Turn): HandlerResult {
  const { tools } = turn;
  const today = tools.now().date;
  const open = tools.openRequests('appointment_request').at(-1);
  if (!open) {
    // Staff may have closed it from the queue. Report that, never "you have no request".
    const last = tools.requests('appointment_request').at(-1);
    const res = last?.resolution;
    const booking = last && bookingState(last, tools.requests());
    if (last && booking) {
      const a = booking.appointment;
      const at = `${formatDate(a.date, today)} at ${formatTime(a.time)}`;
      if (booking.state === 'cancelled') {
        const d = last.details;
        return {
          body: `Your ${d.reason} was cancelled by the clinic staff, as you asked, so there's no visit from it on your schedule. Would you like me to request a new one?`,
          source: 'requests',
          pending: { kind: 'appointment_offer', reason: String(d.reason), provider: String(d.provider), context: d.context as string | undefined },
        };
      }
      const done = booking.state === 'moved'
        ? `Yes. ${endSentence(`Clinic staff moved your ${last.details.reason} to ${at}, with ${a.provider}`)}`
        : `Yes. ${endSentence(`Clinic staff booked your ${last.details.reason} with ${a.provider} for ${at}`)}`;
      const asked = booking.pendingChange;
      const change = asked
        ? asked.details.action === 'cancel'
          ? " You've asked to cancel it; that's pending staff review, so it stays on your schedule for now."
          : ` You've asked to move it to ${formatDate(String(asked.details.preferred_date), today)}; that's pending staff review, so it stays as it is for now.`
        : ' If you need to change it, reply here.';
      return { body: `${done}${change}`, source: 'requests' };
    }
    if (last && res?.outcome === 'not_booked') {
      const d = last.details;
      return {
        body: `Clinic staff weren't able to book your ${d.reason} for ${formatDate(String(d.date), today)}, ${windowText(d.window)}. Would you like me to request it again for another day?`,
        source: 'requests',
        pending: { kind: 'appointment_offer', reason: String(d.reason), provider: String(d.provider), context: d.context as string | undefined },
      };
    }
    if (last?.status === 'completed') {
      const phone = tools.faq('phone')?.split(',')[0];
      return {
        body: `Your request for a ${describeAppointmentRequest(last, today)} was marked completed by the clinic staff. I can't see the final appointment details from here, so I can't confirm a date or time.${phone ? ` You can check with the clinic at ${phone} during business hours.` : ''}`,
        source: 'requests',
      };
    }
    if (last?.status === 'cancelled') {
      const d = last.details;
      return {
        body: `Your request for a ${describeAppointmentRequest(last, today)} was closed by the clinic staff, so there's no visit from it on your schedule. Would you like me to request it again?`,
        source: 'requests',
        pending: { kind: 'appointment_offer', reason: String(d.reason), provider: String(d.provider), context: d.context as string | undefined },
      };
    }
    return { body: "You don't have an appointment request waiting right now. Would you like me to request one?", source: 'requests' };
  }
  const state = open.status === 'in_progress' ? 'being worked on by staff' : 'pending staff review';
  return {
    body: `Not yet. Your request for a ${describeAppointmentRequest(open, today)} is ${state}. It isn't booked. ${NOT_MONITORED} I can't give you a timeline.`,
    source: 'requests',
  };
}

function nextAppointment(turn: Turn): HandlerResult {
  const { tools } = turn;
  const today = tools.now().date;
  const booked = bookedAppointments(tools);
  const open = tools.openRequests('appointment_request').at(-1);
  const parts: string[] = [];
  if (booked[0]) {
    const a = booked[0];
    parts.push(endSentence(`Your next booked appointment is your ${describeBooked(a, today)}`));
    if (booked[1]) parts.push(endSentence(`After that, your ${describeBooked(booked[1], today)}`));
    const change = tools.openRequests('appointment_change').find((r) => r.details.appointment === appointmentKey(a));
    if (change) parts.push(`You've asked to ${change.details.action === 'cancel' ? 'cancel' : 'move'} it, and that's pending staff review, so it stays as it is for now.`);
  } else {
    parts.push("You don't have any booked appointments on file.");
  }
  if (open) parts.push(`Separately, your ${describeAppointmentRequest(open, today)} is a request that's pending staff review. It isn't a booked appointment yet.`);
  return { body: parts.join(' '), source: 'record' };
}

/**
 * Move or cancel an appointment. The booked physical and the pending recheck request are different
 * records: a change to the booked one is its own request for staff, and never edits the recheck.
 * Nothing is moved or cancelled here; there is no tool for it.
 */
function changeAppointment(turn: Turn, i: Interpretation): HandlerResult {
  const { tools, inbound } = turn;
  const today = tools.now().date;
  const action = i.action ?? 'reschedule';
  const bookedList = bookedAppointments(tools);
  const mentioned = mentionedAppointment(inbound.body, bookedList);
  const request = tools.openRequests('appointment_request').at(-1);
  // "Change it": whatever Alex was just talking about. That's the open request if there is one;
  // otherwise the visit staff most recently booked from Alex's request (not asking what it's for).
  const pronounOnly = !i.target && !mentioned && !/\b(appointment|visit)\b/i.test(inbound.body);
  const lastBooked = tools.requests('appointment_request').filter((r) => r.resolution?.outcome === 'booked').at(-1);
  const justBooked = lastBooked && bookedList.find((a) => a.type === String(lastBooked.details.reason));
  const booked = mentioned ?? (pronounOnly ? justBooked : undefined) ?? bookedList[0];
  let target = i.target ?? (pronounOnly
    ? (request ? 'request' : booked ? 'booked' : undefined)
    : (booked && !request ? 'booked' : request && !booked ? 'request' : undefined));
  // "Move the recheck" after staff booked it: it's a booked appointment now, not a request.
  if (target === 'request' && !request && mentioned) target = 'booked';

  if (!booked && !request) {
    return { body: "I don't see a booked appointment or an appointment request for you. If you'd like a visit, tell me what it's for and what day works.", source: 'record' };
  }
  if (!target) {
    return {
      body: `Do you mean your booked ${describeBooked(booked!, today)}, or your request for a ${describeAppointmentRequest(request!, today)}?`,
      source: 'clarifying',
      pending: { kind: 'change_target', action, date: i.date, window: i.window, time: i.time },
    };
  }

  if (target === 'request' || !booked) {
    if (!request) return { body: `You don't have an appointment request open right now. Your booked ${describeBooked(booked!, today)} is unchanged.`, source: 'record' };
    if (action === 'reschedule') {
      if (i.date || i.weekday || i.window || i.time || i.topic === 'tomorrow') return appointmentPreference(turn, i);
      return { body: `Sure. What day and time would work better for your ${request.details.reason} request?`, source: 'clarifying' };
    }
    tools.upsertRequest('appointment_request', { reason: request.details.reason, patient_wants_to_withdraw: inbound.body }, [inbound.id]);
    return {
      body: `I've noted on your ${request.details.reason} request that you'd like to withdraw it, so staff will see that when they review it. Nothing was booked from it. ${NOT_MONITORED}`,
      source: 'staff_handoff',
    };
  }

  const appointment = appointmentKey(booked);
  const current = describeBooked(booked, today);
  const base = {
    appointment, current_date: booked.date, current_time: booked.time, provider: booked.provider, type: booked.type,
  };
  if (action === 'cancel') {
    const policy = tools.faq('cancellations');
    tools.upsertRequest('appointment_change', { action: 'cancel', ...base, patient_message: inbound.body }, [inbound.id]);
    return {
      body: `I've asked the clinic staff to cancel your ${current}. Until staff confirm, it stays on your schedule: this is a request, pending staff review.${policy ? ` Cancellation policy: ${policy}` : ''} ${NOT_MONITORED}`,
      source: 'staff_handoff',
    };
  }

  // Reschedule: needs a new day. For a visit in the next two weeks, "Thursday" means the Thursday
  // in the visit's week (Tue Nov 10 → Thu Nov 12), like "Thursday instead". For a visit further out,
  // or when that's the visit's own day, it's the next Thursday. The date is said back to Alex.
  const time = i.time;
  let date = i.date ?? (i.topic === 'tomorrow' ? addDays(today, 1) : undefined);
  if (!date && i.weekday) {
    const wd = WEEKDAYS.indexOf(i.weekday);
    const sameWeek = booked.date <= addDays(today, 14) ? resolveWeekday(today, wd, booked.date) : undefined;
    date = sameWeek && sameWeek !== booked.date ? sameWeek : resolveWeekday(today, wd);
  }
  // Only a time ("move it to 4pm"): the same day as the visit.
  if (!date && time) date = booked.date;
  const pending: Pending = { kind: 'reschedule_time', appointment };
  if (!date) {
    return { body: `Sure. What day and time would you like instead of your ${current}?`, source: 'clarifying', pending };
  }
  const closed = closedOn(date);
  if (closed) return { body: closedDayReply(turn, date, closed, booked.provider, `Your ${current} is unchanged.`), source: 'clarifying', pending };

  const window = (i.window ?? (time ? windowOf(time) : 'any')) as 'morning' | 'afternoon' | 'any';
  const slots = tools.openSlots({ date, window, provider: booked.provider }).map((s) => s.start);
  const picked = time !== undefined && slots.includes(time);
  tools.upsertRequest('appointment_change', {
    action: 'reschedule', ...base,
    preferred_date: date, preferred_window: window, preferred_time: time,
    matching_open_slots: picked ? [time] : slots,
    patient_message: inbound.body,
  }, [inbound.id]);
  const to = `${formatDate(date, today)}, ${time ? `${picked ? 'at' : 'around'} ${formatTime(time)}` : windowText(window)}`;
  const slotText = picked ? '' : slots.length
    ? ` ${endSentence(`Open times then: ${slotList(slots)}`)}`
    : ` I don't see an open time with ${booked.provider} then, so staff will review options with your preference in mind.`;
  return {
    body: `I've asked the clinic staff to move your ${current} to ${endSentence(to)}${slotText} This is a request, not a booking: your current appointment stays as it is until staff confirm a new time. ${NOT_MONITORED}`,
    source: 'staff_handoff',
    pending,
  };
}

// --- clinic info ------------------------------------------------------------

function hoursToday(turn: Turn): string {
  const now = turn.tools.now();
  const day = WEEKDAYS[now.weekday].replace(/^./, (c) => c.toUpperCase());
  const close = formatTime(BUSINESS_HOURS.close);
  const holiday = federalHoliday(now.date);
  if (holiday) return `We're closed today (${day}, ${holiday}).`;
  if (!BUSINESS_HOURS.days.includes(now.weekday)) return `We're closed today (${day}).`;
  if (now.time < BUSINESS_HOURS.open) return `Today (${day}) we're open ${formatTime(BUSINESS_HOURS.open)} to ${close} Pacific.`;
  if (now.time >= BUSINESS_HOURS.close) return `We closed at ${close} Pacific today (${day}).`;
  return `We close at ${close} Pacific today (${day}).`;
}

/** "Are you open on Saturday?": the answer for that day, from the FAQ hours and the holiday calendar. */
function hoursOn(turn: Turn, i: Interpretation): string | undefined {
  const today = turn.tools.now().date;
  const date = i.date ?? (i.topic === 'tomorrow' ? addDays(today, 1) : i.weekday ? resolveWeekday(today, WEEKDAYS.indexOf(i.weekday)) : undefined);
  if (!date || date === today) return undefined;
  const closed = closedOn(date);
  return closed
    ? `We're closed on ${formatDate(date, today)} (${closed}).`
    : `On ${formatDate(date, today)} we're open ${formatTime(BUSINESS_HOURS.open)} to ${formatTime(BUSINESS_HOURS.close)} Pacific.`;
}

function clinicInfo(turn: Turn, i: Interpretation): HandlerResult {
  const topic = i.topic === 'tomorrow' ? 'hours' : i.topic ?? '';
  const text = turn.tools.faq(topic);
  if (!text) return notInData(turn, { intent: 'not_in_data', topic });
  if (topic === 'hours') return { body: `${hoursOn(turn, i) ?? hoursToday(turn)} Our hours are ${text}`, source: 'faq' };
  const label = topic.replace(/^./, (c) => c.toUpperCase());
  return { body: `${label}: ${text}`, source: 'faq' };
}

function recordInfo(turn: Turn, i: Interpretation): HandlerResult {
  const p = turn.tools.patient(i.topic as keyof Patient);
  switch (i.topic) {
    case 'provider':
      return { body: `Your record shows your last visit was with ${p.last_visit.provider} on ${formatDate(p.last_visit.date)}, and your next booked appointment is with ${bookedAppointments(turn.tools)[0]?.provider ?? 'no one yet'}.`, source: 'record' };
    case 'medications':
      return { body: `Your record lists: ${p.medications.map((m) => `${m.name} ${m.dose}, ${m.frequency}`).join('; ')}. For questions about how to take it, I can pass a question to a clinician.`, source: 'record' };
    case 'pharmacy':
      return { body: `Your pharmacy on file is ${p.pharmacy}.`, source: 'record' };
    case 'insurance':
      return { body: `Your insurance on file is ${p.insurance.payer} ${p.insurance.plan}.`, source: 'record' };
    default:
      return unknown(turn);
  }
}

function notInData(turn: Turn, i: Interpretation): HandlerResult {
  const topic = i.topic || 'that';
  // Say what we do know: Alex's own plan is on file, even though the accepted-plans list isn't.
  const ins = /insurance/.test(topic) ? turn.tools.patient('insurance').insurance : undefined;
  const onFile = ins ? ` Your record lists ${ins.payer} ${ins.plan} as your insurance.` : '';
  return {
    body: `I don't have information about ${topic}, so I can't answer that here.${onFile} Would you like me to pass your question to the clinic staff?`,
    source: 'not_available',
    pending: { kind: 'pass_to_staff', question: turn.inbound.body, topic, messageId: turn.inbound.id },
  };
}

// --- handoffs ---------------------------------------------------------------

function refill(turn: Turn, i: Interpretation): HandlerResult {
  const { tools, inbound } = turn;
  const p = tools.patient('medications');
  const named = i.medication && p.medications.find((m) => m.name.toLowerCase() === i.medication!.toLowerCase());
  // "my BP med": with one medication on file there is nothing to ask.
  const med = named || (p.medications.length === 1 ? p.medications[0] : undefined);
  if (!med) {
    return { body: `Which medication would you like a refill for? I have ${p.medications.map((m) => m.name).join(', ')} on file.`, source: 'clarifying' };
  }
  const existing = tools.openRequests('refill').find((r) => r.details.medication === med.name);
  // "Has my refill been approved?" is a status question: answer it, don't file or extend a request.
  const asksStatus = /\b(approved|ready|status|yet|update|did|has|was|go(ne)? through|went through)\b/i.test(inbound.body);
  if (existing && asksStatus) {
    return { body: `Not yet. Your refill request for ${med.name} ${med.dose} is pending staff review, not approved yet. ${NOT_MONITORED}`, source: 'requests' };
  }
  const decided = tools.requests('refill').filter((r) => r.details.medication === med.name && r.resolution).at(-1);
  if (!existing && decided && asksStatus) {
    if (decided.resolution!.outcome === 'approved') {
      return { body: `Yes. Clinic staff approved your refill of ${med.name} ${med.dose}. If you need another one later, just ask for a new refill.`, source: 'requests' };
    }
    const phone = tools.faq('phone')?.split(',')[0];
    return {
      body: `Clinic staff couldn't approve your refill of ${med.name} ${med.dose} by text.${phone ? ` You can call the clinic at ${phone} during business hours.` : ''}`,
      source: 'requests',
    };
  }
  tools.upsertRequest('refill', {
    medication: med.name, dose: med.dose, frequency: med.frequency,
    refills_remaining: med.refills_remaining,
    pharmacy: tools.patient('pharmacy').pharmacy,
    prescriber_last_visit: `${p.last_visit.provider}, ${p.last_visit.date}`,
    conditions: p.conditions,
    patient_message: inbound.body,
  }, [inbound.id]);
  const pharmacyName = p.pharmacy.split(',')[0];
  if (existing) {
    return { body: `You already have a refill request for ${med.name} ${med.dose} pending staff review. I've added this message to it. ${NOT_MONITORED}`, source: 'staff_handoff' };
  }
  const noRefills = med.refills_remaining === 0 ? ' Your record shows no refills remaining, so it needs review by the clinic.' : '';
  return {
    body: `I've sent a refill request for ${med.name} ${med.dose}, ${med.frequency}, to the clinic staff, with ${pharmacyName} as your pharmacy.${noRefills} It's pending staff review, not approved yet. ${NOT_MONITORED}`,
    source: 'staff_handoff',
  };
}

function clinicalQuestion(turn: Turn, i: Interpretation): HandlerResult {
  const { tools, inbound } = turn;
  const p = tools.patient('medications');
  const readings = i.readings ?? [];
  const meds = p.medications.map((m) => `${m.name} ${m.dose} ${m.frequency}`).join('; ');
  const reported = readings.length ? `BP readings around ${readings.join(', ')}${i.period ? ` ${i.period}` : ''}` : 'a health concern';
  tools.upsertRequest('clinical_question', {
    patient_question: inbound.body,
    readings,
    period: i.period,
    summary: `Patient reports ${reported}. Question in their words: "${inbound.body}"`,
    current_medications: meds,
    conditions: p.conditions,
    last_visit: `${p.last_visit.date} with ${p.last_visit.provider}: ${p.last_visit.plan_note}`,
  }, [inbound.id]);
  const what = readings.length ? `your readings (around ${readings.join(', ')}${i.period ? ` ${i.period}` : ''}) and your question` : 'your question';
  return {
    body: `I can't give medical advice over text, so I can't answer that myself. I've passed ${what} to a clinician to review, and it's pending staff review. ${NOT_MONITORED} If you think you're having a medical emergency, call 911 or go to the nearest emergency room.`,
    source: 'staff_handoff',
  };
}

function balance(turn: Turn): HandlerResult {
  const { tools } = turn;
  const b = tools.patient('balance').balance;
  if (!b.amount) return { body: "You don't have a balance on file.", source: 'record' };
  const pay = tools.faq('paying a balance');
  const phone = tools.faq('phone')?.split(',')[0];
  return {
    body: `Your balance is $${b.amount.toFixed(2)}, listed on your account as "${b.reason}". You can pay ${pay}${phone ? ` The clinic's number is ${phone}.` : ''}`,
    source: 'record',
  };
}

function billingIssue(turn: Turn): HandlerResult {
  const { tools, inbound } = turn;
  const b = tools.patient('balance').balance;
  tools.upsertRequest('billing', { question: inbound.body, balance_on_file: b.amount, balance_reason: b.reason }, [inbound.id]);
  return { body: `I've passed this to the billing staff along with your balance details. It's pending staff review. ${NOT_MONITORED}`, source: 'staff_handoff' };
}

function listRequests(turn: Turn): HandlerResult {
  const { tools } = turn;
  const today = tools.now().date;
  // Emergency handoffs are internal (Alex is never told staff will review them), and a declined
  // outreach is a note for staff, not something Alex asked for.
  const mine = tools.requests().filter((r) => r.type !== 'emergency' && r.type !== 'outreach_declined');
  const open = mine.filter((r) => r.status === 'pending_staff' || r.status === 'in_progress');
  const closed = mine.filter((r) => !open.includes(r));
  const line = (r: Request): string => {
    const d = r.details;
    switch (r.type) {
      case 'appointment_request': return `A ${describeAppointmentRequest(r, today)} (a request, not booked yet)`;
      case 'appointment_change': {
        const what = `your ${String(d.type).toLowerCase()} on ${formatDate(String(d.current_date), today)}`;
        return d.action === 'cancel'
          ? `To cancel ${what}`
          : `To move ${what} to ${formatDate(String(d.preferred_date), today)}, ${windowText(d.preferred_window)}`;
      }
      case 'refill': return `A refill of ${d.medication} ${d.dose}, ${d.frequency}, at ${String(d.pharmacy).split(',')[0]}`;
      case 'clinical_question': {
        const readings = d.readings as string[];
        return `Your question for a clinician${readings?.length ? ` about your readings (around ${readings.join(', ')})` : ''}`;
      }
      default: return `Your question: "${d.question}"`;
    }
  };
  const outcome = (r: Request): string => {
    const res = r.resolution;
    if (!res) return r.status === 'completed' ? 'marked completed' : 'closed';
    switch (res.outcome) {
      case 'booked': {
        const b = bookingState(r, mine)!;
        const at = `${formatDate(b.appointment.date, today)} at ${formatTime(b.appointment.time)}`;
        if (b.state === 'cancelled') return 'booked, then cancelled';
        return b.state === 'moved' ? `booked, then moved to ${at}` : `booked for ${at}`;
      }
      case 'not_booked': return "staff couldn't book it";
      case 'approved': return 'approved';
      case 'denied': return 'not approved';
      case 'done': return 'done';
      case 'not_done': return "staff couldn't make the change";
      case 'answered': return 'the clinic replied';
    }
  };
  const closedTitle = (r: Request) => (r.type === 'appointment_request' ? `Your ${r.details.reason} with ${r.details.provider}` : line(r));
  const closedText = closed.length
    ? `Already handled by staff:\n${closed.map((r) => `- ${closedTitle(r)}: ${outcome(r)}`).join('\n')}\n`
    : '';
  if (!open.length) {
    return { body: `You don't have any requests waiting for staff right now.${closedText ? `\n${closedText.trimEnd()}` : ''}`, source: 'requests' };
  }
  const items = open.map((r, n) => `${n + 1}) ${line(r)}`).join('\n');
  return {
    body: `Here's what you've asked for so far. Each one is pending staff review:\n${items}\n${closedText}${NOT_MONITORED}`,
    source: 'requests',
  };
}

// --- conversational ---------------------------------------------------------

function affirm(turn: Turn): HandlerResult {
  const { pending, inbound, tools } = turn;
  switch (pending?.kind) {
    case 'appointment_offer':
      return askForTime(turn, pending.reason, pending.provider, pending.context, [turn.pendingMessageId!, inbound.id]);
    case 'pass_to_staff':
      tools.upsertRequest('other', { question: pending.question, topic: pending.topic }, [pending.messageId, inbound.id]);
      return { body: `Done. I've passed your question to the clinic staff, and it's pending staff review. ${NOT_MONITORED}`, source: 'staff_handoff' };
    case 'appointment_time':
      return { body: 'What day and time work best for you?', source: 'clarifying', pending };
    default:
      return { body: 'Thanks, Alex. What can I help you with?', source: 'general' };
  }
}

function decline(turn: Turn): HandlerResult {
  const { pending, tools, inbound } = turn;
  // The clinic reached out (e.g. Dr. Lee's recheck). A "no" is useful to staff, or they'd follow up again.
  if (pending?.kind === 'appointment_offer' || pending?.kind === 'appointment_time') {
    const sources = pending.kind === 'appointment_time' && pending.sourceMessageIds?.length
      ? pending.sourceMessageIds
      : turn.pendingMessageId ? [turn.pendingMessageId] : [];
    tools.upsertRequest('outreach_declined', {
      offer: `${pending.reason} with ${pending.provider}`,
      context: pending.context,
      patient_reply: inbound.body,
    }, [...sources, inbound.id]);
    return {
      body: `No problem, I won't request the ${pending.reason}. I've let the clinic staff know you'd rather not schedule it right now. Reply here anytime if you change your mind.`,
      source: 'staff_handoff',
    };
  }
  if (pending?.kind === 'pass_to_staff') {
    return { body: "No problem. I won't send anything to staff. Reply here anytime if you change your mind.", source: 'general' };
  }
  return { body: 'Okay. Let me know if there is anything else I can help with.', source: 'general' };
}

function unknown(turn: Turn): HandlerResult {
  return {
    body: "I'm not sure I can help with that over text. Would you like me to pass your message to the clinic staff?",
    source: 'clarifying',
    pending: { kind: 'pass_to_staff', question: turn.inbound.body, topic: 'patient message', messageId: turn.inbound.id },
  };
}

export const HANDLERS: Record<Intent, (turn: Turn, i: Interpretation) => HandlerResult> = {
  affirm,
  decline,
  appointment_preference: appointmentPreference,
  availability_question: availabilityQuestion,
  appointment_status: appointmentStatus,
  next_appointment: nextAppointment,
  change_appointment: changeAppointment,
  clinic_info: clinicInfo,
  record_info: recordInfo,
  not_in_data: notInData,
  refill,
  clinical_question: clinicalQuestion,
  balance,
  billing_issue: billingIssue,
  list_requests: listRequests,
  thanks: () => ({ body: "You're welcome, Alex.", source: 'general' }),
  unknown,
};


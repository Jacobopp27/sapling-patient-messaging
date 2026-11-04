// Intent handlers: plain code that reads data through tools, files requests, and builds the reply
// from templates. Patient-facing safety wording lives here, not in a model prompt.
import { addDays, federalHoliday, formatDate, formatTime, resolveWeekday, weekdayOf, WEEKDAYS, windowOf } from '../clock';
import { BUSINESS_HOURS, type Appointment, type Patient } from '../data';
import type { AgentTools } from '../tools';
import type { Message, Pending, ReplySource, Request } from '../types';
import type { Interpretation, Intent } from './interpretation';

export interface Turn {
  tools: AgentTools;
  inbound: Message;
  /** What the previous outbound message was waiting for, and that message's id. */
  pending?: Pending;
  pendingMessageId?: number;
  /** For an appointment_reason follow-up: Alex's text is the reason. */
  reasonOverride?: string;
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

/** Booked appointments on file from today on, soonest first. */
function bookedAppointments(tools: AgentTools): Appointment[] {
  const today = tools.now().date;
  return tools.patient('upcoming_appointments').upcoming_appointments
    .filter((a) => a.status === 'booked' && a.date >= today)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

const appointmentKey = (a: Appointment) => `${a.type} ${a.date} ${a.time}`;

function describeBooked(a: Appointment, today: string): string {
  return `${a.type.toLowerCase()} with ${a.provider} on ${formatDate(a.date, today)} at ${formatTime(a.time)}`;
}

// --- appointments -----------------------------------------------------------

function openings(turn: Turn, provider: string): string {
  const { tools } = turn;
  const byDate = new Map<string, string[]>();
  for (const s of tools.openSlots({ provider })) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s.start]);
  const today = tools.now().date;
  const options = [...byDate].map(([date, times]) => `${formatDate(date, today)} (${slotList(times)})`);
  return options.length ? ` ${shortName(provider)} currently has openings on ${options.join(' and ')}.` : '';
}

function askForTime(turn: Turn, reason: string, provider: string, context: string | undefined, sourceMessageIds: number[]): HandlerResult {
  return {
    body: `Great, I'll request a ${reason} with ${provider} for you. What day and time work best for you?${openings(turn, provider)}`,
    source: 'open_slots',
    pending: { kind: 'appointment_time', reason, provider, context, sourceMessageIds },
  };
}

function appointmentPreference(turn: Turn, i: Interpretation): HandlerResult {
  const { tools, inbound, pending } = turn;
  const patient = tools.patient('last_visit');
  const today = tools.now().date;
  const existing = tools.openRequests('appointment_request').at(-1);
  const offer = pending && (pending.kind === 'appointment_offer' || pending.kind === 'appointment_time') ? pending : undefined;
  const fromReasonPrompt = pending?.kind === 'appointment_reason' ? pending : undefined;

  const reason = turn.reasonOverride ?? (existing?.details.reason as string | undefined) ?? offer?.reason;
  const provider = (existing?.details.provider as string | undefined) ?? offer?.provider ?? patient.last_visit.provider;
  const context = (existing?.details.context as string | undefined) ?? offer?.context;
  // Link the clinic's offer (and Alex's "yes") to the request, so staff see where it came from.
  const priorSources = offer?.kind === 'appointment_time' ? offer.sourceMessageIds ?? []
    : offer && turn.pendingMessageId ? [turn.pendingMessageId] : [];

  const time = i.time ?? fromReasonPrompt?.time;
  let date = i.date ?? (i.topic === 'tomorrow' ? addDays(today, 1) : undefined);
  // Answering the clinic's offer, "Thursday" means the Thursday with openings (Nov 12, the one we
  // list), not tomorrow, which has none. The date is said back, so Alex can correct it.
  if (!date && i.weekday && !existing && offer) {
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
  const slots = tools.openSlots({ date, window: finalWindow, provider }).map((s) => s.start);
  tools.upsertRequest('appointment_request', {
    reason, provider, date, window: finalWindow,
    preferred_time: time,
    matching_open_slots: slots,
    context,
  }, [...priorSources, inbound.id]);

  const when = `${formatDate(date, today)}, ${time ? `around ${formatTime(time)}` : windowText(finalWindow)}`;
  const slotText = slots.length
    ? ` ${endSentence(`Open times then: ${slotList(slots)}`)}`
    : ` I don't see an open time with ${provider} then, so staff will review options with your preference in mind.`;
  const body = existing
    ? `Updated: your ${reason} request is now for ${when}, with ${provider}.${slotText} It's still one request, and it's still pending staff review, not booked. ${NOT_MONITORED}`
    : `Got it. I've requested a ${reason} with ${provider} for ${endSentence(when)}${slotText} This is a request, not a booking: it's pending staff review. ${NOT_MONITORED}`;
  return { body, source: 'staff_handoff' };
}

function appointmentStatus(turn: Turn): HandlerResult {
  const { tools } = turn;
  const today = tools.now().date;
  const open = tools.openRequests('appointment_request').at(-1);
  if (!open) {
    // Staff may have closed it from the queue. Report that, never "you have no request".
    const last = tools.requests('appointment_request').at(-1);
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
  const booked = bookedAppointments(tools)[0];
  const request = tools.openRequests('appointment_request').at(-1);
  const target = i.target ?? (booked && !request ? 'booked' : request && !booked ? 'request' : undefined);

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

  // Reschedule: needs a new day. "Thursday" means the next Thursday; the date is said back so Alex can correct it.
  const time = i.time;
  let date = i.date ?? (i.topic === 'tomorrow' ? addDays(today, 1) : undefined);
  if (!date && i.weekday) date = resolveWeekday(today, WEEKDAYS.indexOf(i.weekday));
  const pending: Pending = { kind: 'reschedule_time', appointment };
  if (!date) {
    return { body: `Sure. What day and time would you like instead of your ${current}?`, source: 'clarifying', pending };
  }
  const closed = closedOn(date);
  if (closed) return { body: closedDayReply(turn, date, closed, booked.provider, `Your ${current} is unchanged.`), source: 'clarifying', pending };

  const window = (i.window ?? (time ? windowOf(time) : 'any')) as 'morning' | 'afternoon' | 'any';
  tools.upsertRequest('appointment_change', {
    action: 'reschedule', ...base,
    preferred_date: date, preferred_window: window, preferred_time: time,
    matching_open_slots: tools.openSlots({ date, window, provider: booked.provider }).map((s) => s.start),
    patient_message: inbound.body,
  }, [inbound.id]);
  return {
    body: `I've asked the clinic staff to move your ${current} to ${formatDate(date, today)}, ${windowText(window)}. This is a request, not a booking: your current appointment stays as it is until staff confirm a new time. ${NOT_MONITORED}`,
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
  const status = (r: Request) => (r.status === 'completed' ? 'marked completed' : 'closed');
  const closedText = closed.length
    ? `Already handled by staff:\n${closed.map((r) => `- ${line(r)} (${status(r)})`).join('\n')}\n`
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


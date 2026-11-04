// The clinic side of the demo: what the agent handled, the requests it filed (a worklist), and a box
// for staff to text Alex. Nothing here is booked or approved until staff act. No login: the spec lists
// auth as not required, so this panel is a role in the demo, not a permission boundary.
import { useEffect, useState } from 'react';
import { formatDate, formatTime } from '../../server/clock';
import { bookingState, draftUpdate, needsAppointment, OUTCOME_LABEL, OUTCOMES, type ResolveInput } from '../../server/resolutions';
import type { ScriptStep } from '../../server/script';
import type { Message, ReplySource } from '../../server/types';
import type { AppState, QueueRequest } from './api';

const STATUSES = ['pending_staff', 'in_progress', 'completed', 'cancelled'];
const STATUS_LABEL: Record<string, string> = { pending_staff: 'Pending staff', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };

/** How each agent reply counts in the activity line. */
const OUTCOME: Partial<Record<ReplySource, 'answered' | 'asked' | 'filed' | 'emergency'>> = {
  record: 'answered', faq: 'answered', requests: 'answered', not_available: 'answered',
  open_slots: 'asked', clarifying: 'asked',
  staff_handoff: 'filed',
  emergency_rule: 'emergency',
};

const stamp = (iso: string) => new Date(iso).toLocaleString('en-US', {
  timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
});
/** "Tue, Nov 10" */
const day = (date: unknown) => (date ? formatDate(String(date)).replace(/^(\w{3})\w*/, '$1') : '');
const quote = (text: unknown, n = 70) => {
  const t = String(text ?? '');
  return `“${t.length > n ? `${t.slice(0, n)}…` : t}”`;
};

/** One line that says what a request is about, so the worklist reads without opening anything. */
function summary(r: QueueRequest): string {
  const d = r.details;
  switch (r.type) {
    case 'appointment_request': {
      const when = d.preferred_time ? ` at ${formatTime(String(d.preferred_time))}` : d.window && d.window !== 'any' ? `, ${d.window}` : '';
      return `${d.reason} with ${d.provider}${d.date ? `, ${day(d.date)}${when}` : ', day not chosen yet'}`;
    }
    case 'appointment_change':
      return d.action === 'cancel'
        ? `Cancel the ${String(d.type).toLowerCase().replace(/^bp/, 'BP')} on ${day(d.current_date)}`
        : `Move the ${String(d.type).toLowerCase().replace(/^bp/, 'BP')} from ${day(d.current_date)}${d.preferred_date ? ` to ${day(d.preferred_date)}` : ''}`;
    case 'refill': return `${d.medication} ${d.dose}, ${d.frequency}, to ${String(d.pharmacy).split(',')[0]}`;
    case 'clinical_question': {
      const readings = d.readings as string[] | undefined;
      return readings?.length ? `Readings ${readings.join(', ')}: ${quote(d.patient_question, 50)}` : quote(d.patient_question);
    }
    case 'emergency': return `Signals: ${(d.signals as string[]).join(', ')}`;
    case 'outreach_declined': return `${d.offer}: ${quote(d.patient_reply, 40)}`;
    default: return quote(d.question);
  }
}

export function StaffConsole({ state, busy, scriptStep, onSend, onShowSources, onStatus, onResolve }: {
  state: AppState;
  busy: boolean;
  scriptStep?: ScriptStep;
  onSend: (body: string) => void;
  onShowSources: (ids: number[]) => void;
  onStatus: (id: number, status: string) => void;
  onResolve: (id: number, body: ResolveInput) => void;
}) {
  const [draft, setDraft] = useState('');
  const send = () => {
    const body = draft.trim();
    if (!body || busy) return;
    setDraft('');
    onSend(body);
  };

  return (
    <aside className="console" aria-label="Clinic staff console">
      <header className="console-head">
        <h2>Clinic console</h2>
        <AgentActivity messages={state.messages} />
      </header>

      <Worklist requests={state.requests} busy={busy} onShowSources={onShowSources} onStatus={onStatus} onResolve={onResolve} />

      <section className="staff-reply" aria-label="Text Alex as clinic staff">
        <div className="staff-reply-head">
          <h3>Text Alex as the clinic</h3>
          {scriptStep && (
            <button className="link" onClick={() => setDraft(scriptStep.body)} disabled={busy}>Use script step {scriptStep.step}</button>
          )}
        </div>
        <textarea
          value={draft}
          rows={2}
          placeholder={`To ${state.patient.phone}. Saved in the demo ${state.hosted ? 'database' : 'thread'}; no SMS is sent.`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && send()}
        />
        <div className="staff-reply-foot">
          <span>The agent doesn't answer clinic messages. If you offer something, Alex's reply is matched to it.</span>
          <button className="primary" onClick={send} disabled={busy || !draft.trim()}>Send to Alex</button>
        </div>
      </section>
    </aside>
  );
}

/** "Show which questions the agent has answered and which requests are awaiting staff review." */
function AgentActivity({ messages }: { messages: Message[] }) {
  const counts = { answered: 0, asked: 0, filed: 0, emergency: 0 };
  for (const m of messages) {
    const o = m.author === 'agent' && m.meta.source ? OUTCOME[m.meta.source] : undefined;
    if (o) counts[o]++;
  }
  const inbound = messages.filter((m) => m.author === 'patient').length;
  if (!inbound) return <p className="activity-empty">Nothing yet. Alex's messages and the agent's work show up here.</p>;
  return (
    <dl className="activity" aria-label="What the agent handled">
      <div><dt>From Alex</dt><dd>{inbound}</dd></div>
      <div><dt>Answered from data</dt><dd>{counts.answered}</dd></div>
      <div><dt>Asked Alex</dt><dd>{counts.asked}</dd></div>
      <div><dt>Filed for staff</dt><dd>{counts.filed}</dd></div>
      <div className={counts.emergency ? 'alert' : ''}><dt>Emergency</dt><dd>{counts.emergency}</dd></div>
    </dl>
  );
}

function Worklist({ requests, busy, onShowSources, onStatus, onResolve }: {
  requests: QueueRequest[];
  busy: boolean;
  onResolve: (id: number, body: ResolveInput) => void;
  onShowSources: (ids: number[]) => void;
  onStatus: (id: number, status: string) => void;
}) {
  const isOpen = (r: QueueRequest) => r.status === 'pending_staff' || r.status === 'in_progress';
  const open = requests.filter(isOpen).sort((a, b) => Number(b.type === 'emergency') - Number(a.type === 'emergency') || b.id - a.id);
  const closed = requests.filter((r) => !isOpen(r)).sort((a, b) => b.id - a.id);
  const newest = open.find((r) => r.type !== 'emergency')?.id;
  const row = (r: QueueRequest) => (
    <RequestRow key={r.id} r={r} all={requests} busy={busy} defaultOpen={r.type === 'emergency' && isOpen(r) || r.id === newest}
      onShowSources={onShowSources} onStatus={onStatus} onResolve={onResolve} />
  );

  return (
    <section className="worklist">
      <div className="worklist-head">
        <h3>Waiting for staff</h3>
        <span className="count">{open.length}</span>
      </div>
      {open.length === 0
        ? <p className="worklist-empty">No requests waiting. When the agent files one, it lands here with everything staff need.</p>
        : open.map(row)}
      {closed.length > 0 && (
        <>
          <div className="worklist-head closed"><h3>Closed by staff</h3><span className="count">{closed.length}</span></div>
          {closed.map(row)}
        </>
      )}
    </section>
  );
}

function RequestRow({ r, all, busy, defaultOpen, onShowSources, onStatus, onResolve }: {
  r: QueueRequest; all: QueueRequest[]; busy: boolean; defaultOpen: boolean;
  onShowSources: (ids: number[]) => void; onStatus: (id: number, status: string) => void;
  onResolve: (id: number, body: ResolveInput) => void;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [raw, setRaw] = useState(false);
  const [resolving, setResolving] = useState(false);
  const res = r.resolution;
  // A visit staff booked may have been moved or cancelled since by a change request.
  const booking = bookingState(r, all);
  const at = (a: { date: string; time: string }) => `${formatDate(a.date)} at ${formatTime(a.time)}`;
  const entries = Object.entries(r.details).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0));
  const { label: _label, missing: _missing, ...record } = r;
  const isOpen = r.status === 'pending_staff' || r.status === 'in_progress';
  const badge = res
    ? <span className="badge resolved">{OUTCOME_LABEL[res.outcome]}</span>
    : <span className={`badge status-${r.status}`}>{STATUS_LABEL[r.status]}</span>;

  return (
    <article className={`req type-${r.type} ${isOpen ? 'open' : 'closed'} ${expanded ? 'expanded' : ''}`}>
      <button className="req-head" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <span className="req-kind">{r.label}</span>
        <span className="req-summary">{summary(r)}</span>
        <span className="req-badges">
          {isOpen && (r.missing.length === 0
            ? <span className="badge ready">Ready</span>
            : <span className="badge missing">Needs detail</span>)}
          {badge}
        </span>
      </button>

      {expanded && (
        <div className="req-body">
          <p className="req-meta">
            Request #{r.id} for {r.patientId}, filed {stamp(r.createdAt)}
            {r.updatedAt !== r.createdAt && <>, <strong>updated {stamp(r.updatedAt)}</strong></>}
          </p>
          {isOpen && (r.missing.length === 0
            ? <p className="note ready">Ready for staff: nothing to ask Alex.</p>
            : <p className="note missing">Needs a follow-up with Alex: missing {r.missing.join(', ')}.</p>)}
          {res && (
            <p className="note resolved">
              Resolved as <strong>{OUTCOME_LABEL[res.outcome].toLowerCase()}</strong>
              {res.appointment && <> for {at(res.appointment)} with {res.appointment.provider}</>}
              {res.note && <>. Staff note: <em>{res.note}</em></>}
            </p>
          )}
          {booking && booking.state !== 'booked' && (
            <p className="note alert">
              {booking.state === 'moved' ? `Moved to ${at(booking.appointment)}` : 'Cancelled'} by change #{booking.change!.id}. This booking is no longer the active one.
            </p>
          )}
          {booking?.pendingChange && (
            <p className="note missing">
              Alex asked to {booking.pendingChange.details.action === 'cancel' ? 'cancel this visit' : `move this visit to ${formatDate(String(booking.pendingChange.details.preferred_date))}`} (change #{booking.pendingChange.id}, waiting for staff).
            </p>
          )}

          <dl className="details">
            {entries.map(([k, v]) => (
              <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd></div>
            ))}
          </dl>

          {resolving && <ResolveForm key={r.updatedAt} r={r} busy={busy} onCancel={() => setResolving(false)} onResolve={(body) => { setResolving(false); onResolve(r.id, body); }} />}

          <footer className="req-actions">
            {!res && !resolving && <button className="primary" onClick={() => setResolving(true)}>Resolve…</button>}
            <label className="status-select">
              <span>Status</span>
              <select value={r.status} onChange={(e) => onStatus(r.id, e.target.value)}>
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </label>
            <button className="link" onClick={() => onShowSources(r.sourceMessageIds)}>
              Show the {r.sourceMessageIds.length} message{r.sourceMessageIds.length === 1 ? '' : 's'} it came from
            </button>
            <button className="link" onClick={() => setRaw(!raw)} aria-expanded={raw}>{raw ? 'Hide' : 'Show'} stored record</button>
          </footer>
          {raw && <pre className="raw">{JSON.stringify(record, null, 2)}</pre>}
        </div>
      )}
    </article>
  );
}

/**
 * Staff record what actually happened. For a visit that's the slot they booked; for a refill,
 * approved or not. Optionally they text Alex: the draft is theirs to edit, and it goes out as a
 * clinic message, not as the agent.
 */
function ResolveForm({ r, busy, onResolve, onCancel }: {
  r: QueueRequest; busy: boolean; onResolve: (body: ResolveInput) => void; onCancel: () => void;
}) {
  const d = r.details;
  const outcomes = OUTCOMES[r.type];
  const slots = (d.matching_open_slots as string[] | undefined) ?? [];
  const [outcome, setOutcome] = useState(outcomes[0]);
  const [date, setDate] = useState(String(d.date ?? d.preferred_date ?? ''));
  const [time, setTime] = useState(String(d.preferred_time ?? slots[0] ?? ''));
  const [provider, setProvider] = useState(String(d.provider ?? ''));
  const [note, setNote] = useState('');
  const withAppointment = needsAppointment(r, outcome);
  const draft = draftUpdate(r, outcome, withAppointment && date && time ? { date, time, provider } : undefined);
  const [message, setMessage] = useState(draft);
  const [edited, setEdited] = useState(false);
  const [notify, setNotify] = useState(Boolean(draft));
  useEffect(() => { if (!edited) setMessage(draft); }, [draft, edited]);

  const submit = () => onResolve({
    outcome,
    ...(withAppointment ? { date, time, provider } : {}),
    note,
    message: notify ? message : undefined,
  });

  return (
    <div className="resolve">
      <div className="row" role="radiogroup" aria-label="Outcome">
        {outcomes.map((o) => (
          <button key={o} role="radio" aria-checked={o === outcome} className={`chip-btn ${o === outcome ? 'on' : ''}`} onClick={() => setOutcome(o)}>
            {OUTCOME_LABEL[o]}
          </button>
        ))}
      </div>
      {withAppointment && (
        <>
          <div className="row">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
            <input className="grow" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider" />
          </div>
          {slots.length > 0 && (
            <div className="row small">
              <span className="muted">Open slots that match:</span>
              {slots.map((t) => <button key={t} className={`chip-btn ${t === time ? 'on' : ''}`} onClick={() => setTime(t)}>{formatTime(t)}</button>)}
            </div>
          )}
        </>
      )}
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Internal note (Alex never sees it)" />
      <label className="row small">
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Text Alex this update (sent as the clinic)
      </label>
      {notify && <textarea rows={3} value={message} onChange={(e) => { setEdited(true); setMessage(e.target.value); }} aria-label="Message to Alex" />}
      <div className="row">
        <button onClick={submit} disabled={busy || (withAppointment && (!date || !time || !provider)) || (notify && !message.trim())}>Resolve request</button>
        <button className="link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

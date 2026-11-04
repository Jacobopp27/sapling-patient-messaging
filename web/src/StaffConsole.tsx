// The clinic side of the demo: what the agent handled, the requests it filed, and a box for staff to
// text Alex. Nothing here is booked or approved until staff act. No login: the spec lists auth as
// not required, so this panel is a role in the demo, not a permission boundary.
import { useState } from 'react';
import type { ScriptStep } from '../../server/script';
import type { Message, ReplySource } from '../../server/types';
import type { AppState, QueueRequest } from './api';

const STATUSES = ['pending_staff', 'in_progress', 'completed', 'cancelled'];

/** How each agent reply counts in the summary. */
const OUTCOME: Partial<Record<ReplySource, 'answered' | 'asked' | 'filed' | 'emergency'>> = {
  record: 'answered', faq: 'answered', requests: 'answered', not_available: 'answered',
  open_slots: 'asked', clarifying: 'asked',
  staff_handoff: 'filed',
  emergency_rule: 'emergency',
};

const time = (iso: string) => new Date(iso).toLocaleString('en-US', {
  timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
});

export function StaffConsole({ state, busy, scriptStep, onSend, onShowSources, onStatus }: {
  state: AppState;
  busy: boolean;
  scriptStep?: ScriptStep;
  onSend: (body: string) => void;
  onShowSources: (ids: number[]) => void;
  onStatus: (id: number, status: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const send = () => {
    const body = draft.trim();
    if (!body || busy) return;
    setDraft('');
    onSend(body);
  };

  return (
    <aside className="queue" aria-label="Clinic staff console">
      <div className="pane-label">Clinic staff console</div>
      <AgentSummary messages={state.messages} />

      <section className="staff-reply">
        <h3>Text Alex as clinic staff</h3>
        {scriptStep && (
          <button className="chip-btn script-next" onClick={() => setDraft(scriptStep.body)} disabled={busy}>
            Fill script step {scriptStep.step}
          </button>
        )}
        <textarea
          value={draft}
          rows={3}
          placeholder={`To ${state.patient.phone}. Saved in the demo ${state.sharedDemo ? 'database' : 'thread'}; no SMS is sent.`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && send()}
        />
        <div className="row">
          <span className="muted small grow">A clinic message isn't answered by the agent. If it offers something, Alex's reply is matched to it.</span>
          <button onClick={send} disabled={busy || !draft.trim()}>Send to Alex</button>
        </div>
      </section>

      <StaffQueue requests={state.requests} onShowSources={onShowSources} onStatus={onStatus} />
    </aside>
  );
}

/** "Show which questions the agent has answered and which requests are awaiting staff review." */
function AgentSummary({ messages }: { messages: Message[] }) {
  const counts = { answered: 0, asked: 0, filed: 0, emergency: 0 };
  for (const m of messages) {
    const o = m.author === 'agent' && m.meta.source ? OUTCOME[m.meta.source] : undefined;
    if (o) counts[o]++;
  }
  const inbound = messages.filter((m) => m.author === 'patient').length;
  return (
    <section className="summary" aria-label="What the agent handled">
      <h3>Agent activity <span className="muted">· {inbound} message{inbound === 1 ? '' : 's'} from Alex</span></h3>
      <div className="summary-grid">
        <div><strong>{counts.answered}</strong><span>answered from the record, FAQ or request status</span></div>
        <div><strong>{counts.asked}</strong><span>asked Alex for a missing detail</span></div>
        <div><strong>{counts.filed}</strong><span>filed or updated a request for staff</span></div>
        <div className={counts.emergency ? 'danger' : ''}><strong>{counts.emergency}</strong><span>emergency rule sent</span></div>
      </div>
    </section>
  );
}

function StaffQueue({ requests, onShowSources, onStatus }: {
  requests: QueueRequest[];
  onShowSources: (ids: number[]) => void;
  onStatus: (id: number, status: string) => void;
}) {
  const isOpen = (r: QueueRequest) => r.status === 'pending_staff' || r.status === 'in_progress';
  const open = requests.filter(isOpen).sort((a, b) => Number(b.type === 'emergency') - Number(a.type === 'emergency'));
  const closed = requests.filter((r) => !isOpen(r));
  const card = (r: QueueRequest) => <RequestCard key={r.id} r={r} onShowSources={onShowSources} onStatus={onStatus} />;

  return (
    <section>
      <h2>Awaiting staff review <span className="muted">· {open.length} open</span></h2>
      <p className="muted small">Requests the agent filed. Nothing here is booked or approved until staff act.</p>
      {open.length === 0 && <p className="muted small empty">No open requests.</p>}
      {open.map(card)}
      {closed.length > 0 && <><h3>Closed by staff</h3>{closed.map(card)}</>}
    </section>
  );
}

function RequestCard({ r, onShowSources, onStatus }: {
  r: QueueRequest; onShowSources: (ids: number[]) => void; onStatus: (id: number, status: string) => void;
}) {
  const [raw, setRaw] = useState(false);
  const entries = Object.entries(r.details).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0));
  const { label: _label, missing: _missing, ...record } = r;
  return (
    <article className={`card type-${r.type}`}>
      <header>
        <strong>{r.label} <span className="muted small">#{r.id}</span></strong>
        <select value={r.status} onChange={(e) => onStatus(r.id, e.target.value)} aria-label="Status (staff action)">
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </header>
      <div className="record-meta">
        <code>{r.type}</code> · {r.patientId} · created {time(r.createdAt)}
        {r.updatedAt !== r.createdAt && <> · <strong>updated {time(r.updatedAt)}</strong></>}
      </div>
      {r.missing.length === 0
        ? <div className="ready">Ready for staff: nothing to ask Alex</div>
        : <div className="missing">Needs follow-up: missing {r.missing.join(', ')}</div>}
      <dl className="details">
        {entries.map(([k, v]) => (
          <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd></div>
        ))}
      </dl>
      <footer className="row">
        <button className="link" onClick={() => onShowSources(r.sourceMessageIds)}>
          Show the {r.sourceMessageIds.length} message{r.sourceMessageIds.length === 1 ? '' : 's'} it came from
        </button>
        <button className="link" onClick={() => setRaw(!raw)} aria-expanded={raw}>{raw ? 'Hide' : 'Show'} stored record</button>
      </footer>
      {raw && <pre className="raw">{JSON.stringify(record, null, 2)}</pre>}
    </article>
  );
}

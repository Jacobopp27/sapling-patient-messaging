import { useEffect, useState } from 'react';
import { SCRIPT } from '../../server/script';
import type { Message } from '../../server/types';
import { api, type AppState } from './api';
import { Chat, SENDER, type Outgoing } from './Chat';
import { StaffConsole } from './StaffConsole';

const CLOCK_PRESETS = [
  { label: 'Wed 10:00 (script)', now: '2026-11-04T10:00:00-08:00' },
  { label: 'Wed 17:30', now: '2026-11-04T17:30:00-08:00' },
  { label: 'Sat 11:00', now: '2026-11-07T11:00:00-08:00' },
];

/**
 * Presentation only: the agent answers instantly, but the UI shows "typing…" for 2–3 s so the
 * thread reads like a real conversation. Emergency replies are never delayed.
 */
const typingDelay = () => 2000 + Math.random() * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


function formatNow(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }) + ' PT';
}

/**
 * A button that asks for a second click instead of window.confirm(), which some embedded browsers
 * (like an app's preview pane) silently answer "no", so the button seemed to do nothing.
 */
function ConfirmButton({ label, confirmLabel, onConfirm, disabled, className }: {
  label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`${className ?? ''} ${armed ? 'armed' : ''}`}
      disabled={disabled}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

/** How many script steps have been sent, judged by matching message bodies in order. */
function stepsSent(messages: Message[]): number {
  let n = 0;
  for (const m of messages) if (m.author !== 'agent' && SCRIPT[n] && m.body === SCRIPT[n].body) n++;
  return n;
}

export function App() {
  const [state, setState] = useState<AppState>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<Message>();
  const [outgoing, setOutgoing] = useState<Outgoing>();
  const [typing, setTyping] = useState(false);
  const [highlight, setHighlight] = useState<number[]>([]);
  const [clockDraft, setClockDraft] = useState('');

  const run = async (fn: () => Promise<AppState>) => {
    setBusy(true);
    setError(undefined);
    try { setState(await fn()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  useEffect(() => { run(api.state); }, []);
  useEffect(() => { if (state) setClockDraft(state.settings.now); }, [state?.settings.now]);
  // After a server restart, refresh when the tab regains focus.
  useEffect(() => {
    const onFocus = () => api.state().then(setState).catch(() => undefined);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  /** Alex's message shows at once; the reply arrives after a short "typing…" pause. */
  const sendAsPatient = async (body: string, quoted?: Message) => {
    setOutgoing({ body, replyTo: quoted });
    const typingStarts = setTimeout(() => setTyping(true), 500);
    const started = Date.now();
    try {
      const next = await api.send('patient', body, quoted?.id);
      const reply = next.messages.at(-1);
      if (reply?.meta.source !== 'emergency_rule') await sleep(Math.max(0, typingDelay() - (Date.now() - started)));
      setState(next);
    } finally {
      clearTimeout(typingStarts);
      setTyping(false);
      setOutgoing(undefined);
    }
  };

  /** Alex's phone: every message goes through the agent. */
  const sendAsAlex = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    const quoted = replyTo;
    setDraft('');
    setReplyTo(undefined);
    setBusy(true);
    setError(undefined);
    try { await sendAsPatient(body, quoted); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const playScript = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setState(await api.reset());
      for (const step of SCRIPT.filter((x) => !x.restartBefore)) {
        if (step.author === 'clinic') setState(await api.send('clinic', step.body));
        else { await sleep(800); await sendAsPatient(step.body); }
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (!state) return <div className="loading">{error ? `Can't reach the API: ${error}` : 'Loading…'}</div>;

  const nextStep = SCRIPT[stepsSent(state.messages)];

  const showSources = (ids: number[]) => {
    setHighlight(ids);
    document.getElementById(`msg-${ids[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => setHighlight([]), 2500);
  };

  return (
    <div className="app">
      <header className="topbar">
        <strong className="title">Sapling patient messaging · {state.sharedDemo ? 'live demo' : 'local demo'}</strong>
        <div className="controls">
          <label className="field">
            <span>Scenario clock</span>
            <div className="row">
              <input value={clockDraft} onChange={(e) => setClockDraft(e.target.value)} size={24} aria-label="Scenario now (ISO)" />
              <button onClick={() => run(() => api.settings({ now: clockDraft }))} disabled={busy}>Set</button>
              {CLOCK_PRESETS.map((p) => (
                <button key={p.now} className={`chip-btn ${state.settings.now === p.now ? 'on' : ''}`} onClick={() => run(() => api.settings({ now: p.now }))}>{p.label}</button>
              ))}
            </div>
            <small className="muted">Now: {formatNow(state.clock)} · runs from the time you set; Reset restarts it</small>
          </label>
          <label className="field">
            <span>Agent</span>
            <select value={state.settings.agentMode} onChange={(e) => run(() => api.settings({ agentMode: e.target.value as 'local' | 'claude' }))}>
              <option value="local">Local rules (no API key)</option>
              <option value="claude" disabled={!state.claudeAvailable}>Claude{state.claudeAvailable ? '' : ' (set ANTHROPIC_API_KEY)'}</option>
            </select>
          </label>
          <div className="field">
            <span>Demo</span>
            <div className="row">
              <ConfirmButton label="Play script 0–11" confirmLabel="Reset and play?" onConfirm={playScript} disabled={busy} />
              <ConfirmButton label="Reset" confirmLabel="Delete all? Click again" className="ghost" onConfirm={() => run(api.reset)} disabled={busy} />
            </div>
          </div>
        </div>
      </header>

      {state.sharedDemo && (
        <div className="shared-note">
          Shared public demo: everyone who opens this page sees the same conversation with the synthetic patient Alex Morgan. Press Reset to start over.
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <main className="layout">
        <section className="wa" aria-label="Alex's phone: conversation with Sapling Family Clinic">
          <div className="pane-label">Alex's phone</div>
          <div className="wa-header">
            <span className="wa-avatar">S</span>
            <div>
              <strong>Sapling Family Clinic</strong>
              <small>{typing ? 'typing…' : 'Texts are read during business hours, not monitored continuously'}</small>
            </div>
          </div>

          <Chat
            messages={state.messages}
            requests={state.requests}
            outgoing={outgoing}
            typing={typing}
            highlight={highlight}
            onReply={(m) => { setReplyTo(m); document.getElementById('composer')?.focus(); }}
          />

          <div className="wa-composer">
            {nextStep?.author === 'patient' && (
              <button className="chip-btn script-next" onClick={() => setDraft(nextStep.body)} disabled={busy}>
                Fill script step {nextStep.step}{nextStep.restartBefore ? ' (restart the server first)' : ''}
              </button>
            )}
            {replyTo && (
              <div className="wa-reply-preview">
                <div>
                  <strong>Replying to {replyTo.author === 'patient' ? 'yourself' : SENDER[replyTo.author]}</strong>
                  <span>{replyTo.body.length > 110 ? `${replyTo.body.slice(0, 110)}…` : replyTo.body}</span>
                </div>
                <button className="ghost" onClick={() => setReplyTo(undefined)} aria-label="Cancel reply">✕</button>
              </div>
            )}
            <div className="row">
              <input
                id="composer"
                className="grow wa-input"
                value={draft}
                placeholder="Message as Alex (from the number on file)"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendAsAlex()}
              />
              <button className="wa-send" onClick={sendAsAlex} disabled={busy || !draft.trim()} aria-label="Send as Alex">➤</button>
            </div>
          </div>
        </section>

        <StaffConsole
          state={state}
          busy={busy}
          scriptStep={nextStep?.author === 'clinic' ? nextStep : undefined}
          onSend={(body) => run(() => api.send('clinic', body))}
          onShowSources={showSources}
          onStatus={(id, s) => run(() => api.setStatus(id, s))}
          onResolve={(id, body) => run(() => api.resolve(id, body))}
        />
      </main>
    </div>
  );
}

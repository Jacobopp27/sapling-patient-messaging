import { useEffect, useRef, useState } from 'react';
import { SCRIPT } from '../../server/script';
import type { Message } from '../../server/types';
import { api, type AppState } from './api';
import { Chat, SENDER, type Outgoing } from './Chat';
import { StaffConsole } from './StaffConsole';

const CLOCK_PRESETS = [
  { label: 'Wed 10:00 a.m., the script', now: '2026-11-04T10:00:00-08:00' },
  { label: 'Wed 5:30 p.m., after closing', now: '2026-11-04T17:30:00-08:00' },
  { label: 'Sat 11:00 a.m., closed', now: '2026-11-07T11:00:00-08:00' },
  { label: 'Wed Nov 11, Veterans Day', now: '2026-11-11T10:00:00-08:00' },
];

/**
 * Presentation only: the agent answers instantly, but the UI shows "typing…" for 2–3 s so the
 * thread reads like a real conversation. Emergency replies are never delayed.
 */
const typingDelay = () => 2000 + Math.random() * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


function formatNow(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
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

  const run = async (fn: () => Promise<AppState>) => {
    setBusy(true);
    setError(undefined);
    try { setState(await fn()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  useEffect(() => { run(api.state); }, []);
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

  const time = new Date(state.clock).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/, '');

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <span className="mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 21c0-6 2-10 8-12-1 6-4 9-8 9m0 3c0-5-2-8-7-9 1 5 3 7 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <div>
            <strong>Sapling Family Clinic</strong>
            <span>Patient messaging, {state.hosted ? 'live demo' : 'local demo'}</span>
          </div>
        </div>
        <div className="bar-controls">
          <ClockControl now={state.settings.now} clock={state.clock} busy={busy} onSet={(now) => run(() => api.settings({ now }))} />
          <label className="agent-select">
            <span>Agent</span>
            <select value={state.settings.agentMode} onChange={(e) => run(() => api.settings({ agentMode: e.target.value as 'local' | 'claude' }))}>
              <option value="local">Local rules</option>
              <option value="claude" disabled={!state.claudeAvailable}>Claude{state.claudeAvailable ? '' : ' (no API key)'}</option>
            </select>
          </label>
          <ConfirmButton label="Play script" confirmLabel="Start over and play?" className="primary" onConfirm={playScript} disabled={busy} />
          <ConfirmButton label="Reset" confirmLabel="Clear everything?" onConfirm={() => run(api.reset)} disabled={busy} />
        </div>
      </header>

      {state.hosted && (
        <div className="shared-note">
          This conversation is yours: it's kept for this browser, and other visitors have their own. Alex Morgan and the clinic data are synthetic.
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}

      <main className="layout">
        <section className="stage" aria-label="Alex's phone">
          <div className="phone">
            <div className="phone-screen">
              <div className="status-bar" aria-hidden>
                <span>{time}</span>
                <span className="status-icons"><i /><i /><i /><b /></span>
              </div>
              <div className="wa-header">
                <span className="wa-avatar">S</span>
                <div>
                  <strong>Sapling Family Clinic</strong>
                  <small>{typing ? 'typing…' : 'Texts are read during business hours'}</small>
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
                {replyTo && (
                  <div className="wa-reply-preview">
                    <div>
                      <strong>Replying to {replyTo.author === 'patient' ? 'yourself' : SENDER[replyTo.author]}</strong>
                      <span>{replyTo.body}</span>
                    </div>
                    <button className="icon-btn" onClick={() => setReplyTo(undefined)} aria-label="Cancel reply">✕</button>
                  </div>
                )}
                <div className="wa-input-row">
                  <input
                    id="composer"
                    className="wa-input"
                    value={draft}
                    placeholder="Text the clinic as Alex"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendAsAlex()}
                  />
                  <button className="wa-send" onClick={sendAsAlex} disabled={busy || !draft.trim()} aria-label="Send as Alex">
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden><path d="M4 12l16-8-6 16-2.5-6.5z" fill="currentColor" /></svg>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="stage-notes">
            {nextStep?.author === 'patient' && (
              <div className="next-step">
                <div>
                  <span>Script step {nextStep.step}{nextStep.restartBefore ? ', after restarting the server' : ''}</span>
                  <q>{nextStep.body}</q>
                </div>
                <button onClick={() => { setDraft(nextStep.body); document.getElementById('composer')?.focus(); }} disabled={busy}>Use it</button>
              </div>
            )}
            <p>Alex Morgan texts from +1-555-010-0199. Drag a bubble to the right to reply to that message.</p>
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

/** The scenario clock: a button that shows "now" and opens the presets and a custom time. */
function ClockControl({ now, clock, busy, onSet }: { now: string; clock: string; busy: boolean; onSet: (now: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(now);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setDraft(now); }, [now]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick); };
  }, [open]);
  const pick = (value: string) => { onSet(value); setOpen(false); };
  return (
    <div className="clock" ref={box}>
      <button className="clock-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        {formatNow(clock)}
      </button>
      {open && (
        <div className="clock-pop" role="dialog" aria-label="Scenario clock">
          <p>The agent reads "now" from here, never from this computer. It keeps running from the time you set.</p>
          <div className="clock-presets">
            {CLOCK_PRESETS.map((p) => (
              <button key={p.now} className={now === p.now ? 'on' : ''} onClick={() => pick(p.now)} disabled={busy}>{p.label}</button>
            ))}
          </div>
          <label>
            <span>Any time (ISO, Pacific offset)</span>
            <div className="clock-custom">
              <input value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button onClick={() => pick(draft)} disabled={busy}>Set</button>
            </div>
          </label>
        </div>
      )}
    </div>
  );
}

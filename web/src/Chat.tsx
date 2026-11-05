// WhatsApp-style thread, seen from Alex's phone: Alex on the right, the clinic on the left.
// Swipe a bubble to the right (or use the reply arrow) to quote it in your reply.
import { useEffect, useRef, useState } from 'react';
import type { Message, ReplySource } from '../../server/types';
import type { QueueRequest } from './api';

export const SOURCE_LABEL: Record<ReplySource, string> = {
  record: 'Answered from the patient record',
  faq: 'Answered from the clinic FAQ',
  open_slots: 'Suggested from open slots',
  requests: 'Answered from request status',
  staff_handoff: 'Sent to staff for review',
  emergency_rule: 'Emergency rule (exact text)',
  not_available: 'Not in the supplied data',
  clarifying: 'Clarifying question',
  general: 'General reply',
};

// As on a real phone, every clinic message comes from one sender: the clinic's number. Whether staff
// or the assistant wrote it is shown only as a small "automated" tag and in the "why?" panel.
export const SENDER: Record<Message['author'], string> = { patient: 'You', clinic: 'Sapling Family Clinic', agent: 'Sapling Family Clinic' };
const WRITTEN_BY: Record<Message['author'], string> = { patient: 'Alex', clinic: 'Clinic staff', agent: 'Sapling assistant (automated)' };
const TZ = 'America/Los_Angeles';
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });
const snippet = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface Outgoing { body: string; replyTo?: Message }

interface ChatProps {
  messages: Message[];
  requests: QueueRequest[];
  outgoing?: Outgoing;
  typing: boolean;
  highlight: number[];
  onReply: (m: Message) => void;
}

export function Chat({ messages, requests, outgoing, typing, highlight, onReply }: ChatProps) {
  const end = useRef<HTMLDivElement>(null);
  const [openWhy, setOpenWhy] = useState<number>();
  const [flash, setFlash] = useState<number>();
  const byId = new Map(messages.map((m) => [m.id, m]));

  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, outgoing, typing]);

  const jumpTo = (id: number) => {
    document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(id);
    setTimeout(() => setFlash(undefined), 1200);
  };

  let lastDay = '';
  return (
    <div className="wa-messages">
      {messages.length === 0 && !outgoing && (
        <div className="wa-system">Start with the clinic's outreach (script step 0), or play the whole script.</div>
      )}
      {messages.map((m) => {
        const d = day(m.createdAt);
        const separator = d !== lastDay ? <div className="wa-day" key={`d-${m.id}`}>{d}</div> : null;
        lastDay = d;
        const quoted = m.meta.explicitReply && m.inReplyTo ? byId.get(m.inReplyTo) : undefined;
        return (
          <div key={m.id}>
            {separator}
            <Bubble
              m={m}
              quoted={quoted}
              highlighted={highlight.includes(m.id) || flash === m.id}
              onReply={() => onReply(m)}
              onJump={jumpTo}
              whyOpen={openWhy === m.id}
              onWhy={() => setOpenWhy(openWhy === m.id ? undefined : m.id)}
              matched={m.author === 'agent' ? byId.get(byId.get(m.inReplyTo ?? -1)?.inReplyTo ?? -1) : undefined}
            />
            {(m.meta.requestEvents ?? []).map((e) => {
              const r = requests.find((x) => x.id === e.requestId);
              // Emergency handoffs stay staff-side: Alex is never told staff will review them.
              if (!r || r.type === 'emergency') return null;
              return (
                <div key={e.requestId} className="wa-system">
                  {r.label} {e.action} · {r.status === 'pending_staff' ? 'pending staff review' : r.status.replace('_', ' ')}
                </div>
              );
            })}
          </div>
        );
      })}
      {outgoing && (
        <div className="wa-row out">
          <div className="wa-bubble out">
            {outgoing.replyTo && <Quote m={outgoing.replyTo} />}
            <span className="wa-text">{outgoing.body}</span>
            <span className="wa-meta">sending <span className="tick">✓</span></span>
          </div>
        </div>
      )}
      {typing && (
        <div className="wa-row in">
          <div className="wa-bubble in typing" aria-label="Sapling assistant is typing">
            <span /><span /><span />
          </div>
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

function Quote({ m, onClick }: { m: Message; onClick?: () => void }) {
  return (
    <button type="button" className={`wa-quote ${m.author}`} onClick={onClick}>
      <strong>{SENDER[m.author]}</strong>
      <span>{snippet(m.body)}</span>
    </button>
  );
}

const SWIPE_TRIGGER = 56;

function Bubble({ m, quoted, highlighted, onReply, onJump, whyOpen, onWhy, matched }: {
  m: Message; quoted?: Message; highlighted: boolean; onReply: () => void; onJump: (id: number) => void;
  whyOpen: boolean; onWhy: () => void; matched?: Message;
}) {
  const side = m.author === 'patient' ? 'out' : 'in';
  const [dx, setDx] = useState(0);
  const start = useRef<number | null>(null);

  // Swipe right to reply, like WhatsApp. Works with touch and mouse drag.
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    start.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (start.current !== null) setDx(Math.max(0, Math.min(80, e.clientX - start.current)));
  };
  const onPointerUp = () => {
    if (dx >= SWIPE_TRIGGER) onReply();
    start.current = null;
    setDx(0);
  };

  const t = m.meta.trace;
  return (
    <div id={`msg-${m.id}`} className={`wa-row ${side} ${highlighted ? 'flash' : ''}`}>
      <span className="wa-swipe-icon" style={{ opacity: dx / SWIPE_TRIGGER }} aria-hidden>↩</span>
      <div
        className={`wa-bubble ${side} ${m.author} ${m.meta.source === 'emergency_rule' ? 'emergency' : ''}`}
        style={{ transform: `translateX(${dx}px)`, transition: dx ? 'none' : 'transform .2s' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {quoted && <Quote m={quoted} onClick={() => onJump(quoted.id)} />}
        <span className="wa-text">{m.body}</span>
        <span className="wa-meta">
          {m.meta.channel === 'voice' && <span className="wa-voice" title="Said on a voice call">call</span>}
          {m.author === 'agent' && <span className="wa-auto" title="Written by the automated assistant">automated</span>}
          {m.author === 'agent' && t && <button type="button" className="wa-why" onClick={onWhy} aria-expanded={whyOpen}>why?</button>}
          {time(m.createdAt)}
          {side === 'out' && <span className="tick" title="Delivered (texts are not monitored continuously)">✓✓</span>}
        </span>
        <button type="button" className="wa-reply-btn" onClick={onReply} aria-label="Reply to this message">↩</button>
      </div>
      {whyOpen && t && (
        <dl className="wa-why-panel">
          <dt>Written by</dt><dd>{WRITTEN_BY[m.author]}, from {m.fromNumber ?? 'the clinic'} to {m.toNumber ?? 'Alex'}</dd>
          <dt>Source</dt><dd>{m.meta.source ? SOURCE_LABEL[m.meta.source] : '—'}</dd>
          {matched && <><dt>Alex was answering</dt><dd>“{snippet(matched.body, 70)}”</dd></>}
          <dt>Understood</dt><dd><code>{JSON.stringify(t.interpretation ?? 'emergency guard (no model)')}</code></dd>
          <dt>Interpreter</dt><dd>{t.interpreter}{t.note ? ` — ${t.note}` : ''}</dd>
          <dt>Tools used</dt><dd>{t.tools.join(' → ') || 'none'}</dd>
          <dt>Emergency guard</dt><dd>{t.guards.emergency}</dd>
          <dt>Reply guard</dt><dd>{t.guards.reply}</dd>
          {m.meta.pending && <><dt>Now waiting for</dt><dd>{m.meta.pending.kind.replace(/_/g, ' ')}</dd></>}
        </dl>
      )}
    </div>
  );
}

// A voice call to the clinic, inside Alex's phone. OpenAI Realtime transcribes what Alex says (over
// WebRTC, with server-side turn detection); each finished sentence goes to the same agent as a text,
// and the agent's reply is read aloud word for word. The microphone is closed while the assistant
// speaks: its voice comes out of the speakers through a plain <audio> element, which browsers don't
// always echo-cancel, so the mic heard it and sent it to the agent as if Alex had said it. Tapping
// the avatar interrupts. Anything that still sounds like the clinic's own words is dropped as echo.
import { useEffect, useRef, useState } from 'react';
import type { Message } from '../../server/types';
import { api, type AppState } from './api';
import { soundsLikeEcho } from './echo';

type Phase = 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'ended' | 'failed';

const PHASE_LABEL: Record<Phase, string> = {
  connecting: 'Calling…',
  listening: 'Listening',
  hearing: 'Hearing you…',
  thinking: 'One moment…',
  speaking: 'Speaking',
  ended: 'Call ended',
  failed: "Couldn't connect",
};

interface Line { who: 'Alex' | 'Clinic'; text: string; final: boolean }


export function CallScreen({ onState, onClose }: { onState: (s: AppState) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [error, setError] = useState<string>();
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const call = useRef<{
    pc?: RTCPeerConnection; mic?: MediaStream; audio?: HTMLAudioElement; ctx?: AudioContext;
    queue: Promise<void>; callId: string; closed: boolean; muted: boolean; spoken: string[];
  }>({ queue: Promise.resolve(), callId: `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, closed: false, muted: false, spoken: [] });
  const transcript = useRef<HTMLDivElement>(null);

  const say = (who: Line['who'], text: string, final = true) => setLines((all) => {
    const last = all.at(-1);
    // Live words replace the unfinished line from the same speaker.
    return last && !last.final && last.who === who ? [...all.slice(0, -1), { who, text, final }] : [...all, { who, text, final }];
  });

  /** The mic is open unless Alex muted it or the assistant is talking. */
  const setMicOpen = (open: boolean) => {
    const c = call.current;
    c.mic?.getAudioTracks().forEach((t) => { t.enabled = open && !c.muted; });
  };

  /** Read one of the clinic's messages aloud, exactly as saved. The mic is closed meanwhile (no echo). */
  const speakMessage = async (m: Message) => {
    const c = call.current;
    if (c.closed) return;
    say('Clinic', m.body);
    c.spoken = [...c.spoken.slice(-3), m.body];
    setPhase('speaking');
    const blob = await api.speech(m.id);
    if (c.closed) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    c.audio = audio;
    setMicOpen(false);
    await new Promise<void>((resolve) => {
      audio.onended = audio.onpause = () => resolve();
      audio.play().catch(() => resolve());
    });
    URL.revokeObjectURL(url);
    if (c.audio === audio) c.audio = undefined;
    // A short tail, so the end of the speech still in the room isn't picked up.
    await new Promise((r) => setTimeout(r, 250));
    if (!c.closed) setMicOpen(true);
    // Alex may have already started talking over it ('hearing'); don't step on that.
    if (!c.closed) setPhase((p) => (p === 'speaking' ? 'listening' : p));
  };

  /** One finished sentence from Alex: through the agent, then the reply spoken. One turn at a time. */
  const handleTurn = (text: string) => {
    const c = call.current;
    c.queue = c.queue.then(async () => {
      if (c.closed || !text.trim()) return;
      setPhase('thinking');
      const next = await api.sendVoice(text.trim(), c.callId);
      onState(next);
      const reply = next.messages.at(-1);
      if (reply && reply.author === 'agent') await speakMessage(reply);
    }).catch((e) => { setError((e as Error).message); setPhase('listening'); });
  };

  useEffect(() => {
    const c = call.current;
    let raf = 0;
    const start = async () => {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        c.mic = mic;
        if (c.closed) return mic.getTracks().forEach((t) => t.stop());

        // Mic level for the ring around the avatar.
        const ctx = new AudioContext();
        c.ctx = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(mic).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
          setLevel(Math.min(1, peak / 50));
          raf = requestAnimationFrame(tick);
        };
        tick();

        const token = await api.callToken();
        const pc = new RTCPeerConnection();
        c.pc = pc;
        mic.getTracks().forEach((t) => pc.addTrack(t, mic));
        const events = pc.createDataChannel('oai-events');
        events.onmessage = (e) => {
          const ev = JSON.parse(e.data) as { type: string; delta?: string; transcript?: string };
          if (ev.type === 'input_audio_buffer.speech_started') {
            c.audio?.pause(); // Alex talks over the assistant: stop speaking and listen
            setPhase('hearing');
          } else if (ev.type === 'conversation.item.input_audio_transcription.delta' && ev.delta) {
            setLines((all) => {
              const last = all.at(-1);
              return last && !last.final && last.who === 'Alex'
                ? [...all.slice(0, -1), { ...last, text: last.text + ev.delta }]
                : [...all, { who: 'Alex', text: ev.delta!, final: false }];
            });
          } else if (ev.type === 'conversation.item.input_audio_transcription.completed') {
            const text = ev.transcript ?? '';
            if (text.trim() && soundsLikeEcho(text, c.spoken)) {
              // The mic heard the clinic's own voice: not something Alex said.
              setLines((all) => (all.at(-1)?.final === false ? all.slice(0, -1) : all));
              setPhase((p) => (p === 'hearing' ? 'listening' : p));
            } else if (text.trim()) {
              say('Alex', text.trim());
              handleTurn(text);
            } else {
              setLines((all) => (all.at(-1)?.final === false ? all.slice(0, -1) : all));
              setPhase('listening');
            }
          } else if (ev.type === 'error') {
            setError((ev as { error?: { message?: string } }).error?.message ?? 'transcription error');
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const answer = await fetch('https://api.openai.com/v1/realtime/calls', {
          method: 'POST',
          body: offer.sdp,
          headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/sdp' },
        });
        if (!answer.ok) throw new Error(`OpenAI didn't accept the call (${answer.status})`);
        await pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() });
        if (c.closed) return;

        // The clinic picks up: the greeting is saved in the thread and spoken.
        const next = await api.startCall(c.callId);
        onState(next);
        const greeting = next.messages.at(-1);
        if (greeting) c.queue = c.queue.then(() => speakMessage(greeting));
        else setPhase('listening');
      } catch (e) {
        setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser and call again.' : (e as Error).message);
        setPhase('failed');
      }
    };
    start();
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => {
      c.closed = true;
      clearInterval(timer);
      cancelAnimationFrame(raf);
      c.audio?.pause();
      c.pc?.close();
      c.mic?.getTracks().forEach((t) => t.stop());
      c.ctx?.close().catch(() => undefined);
    };
  }, []);

  useEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight }); }, [lines]);

  const toggleMute = () => {
    const next = !muted;
    call.current.muted = next;
    setMicOpen(!call.current.audio);
    setMuted(next);
  };
  /** Tap the avatar while the assistant talks: stop it and listen. */
  const interrupt = () => call.current.audio?.pause();
  const hangUp = () => {
    const c = call.current;
    c.closed = true;
    c.audio?.pause();
    setPhase('ended');
    onClose();
  };

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const live = phase !== 'failed' && phase !== 'ended';

  return (
    <div className="call" role="dialog" aria-label="Voice call with Sapling Family Clinic">
      <div className="call-top">
        {phase === 'speaking' ? (
          <button className={`call-avatar ${phase}`} onClick={interrupt} aria-label="Interrupt the assistant">S</button>
        ) : (
          <div className={`call-avatar ${phase}`} style={{ '--level': muted ? 0 : level } as React.CSSProperties}>S</div>
        )}
        <strong>Sapling Family Clinic</strong>
        <span className="call-phase" aria-live="polite">{PHASE_LABEL[phase]}{live && phase !== 'connecting' ? ` · ${clock}` : ''}</span>
        {phase === 'speaking' && <span className="call-tip">Tap the S to interrupt</span>}
        {error && <span className="call-error" role="alert">{error}</span>}
      </div>

      <div className="call-transcript" ref={transcript} aria-live="polite">
        {lines.length === 0 && live && <p className="call-hint">Talk as Alex once the clinic answers. Try "Tuesday afternoon works" or "can I get a refill on my BP med".</p>}
        {lines.map((l, i) => (
          <p key={i} className={`call-line ${l.who === 'Alex' ? 'alex' : 'clinic'} ${l.final ? '' : 'partial'}`}>
            <span>{l.who}</span>{l.text}
          </p>
        ))}
      </div>

      <div className="call-controls">
        <button className={`call-btn ${muted ? 'on' : ''}`} onClick={toggleMute} disabled={!live} aria-pressed={muted}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            {muted && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
          </svg>
          <span>{muted ? 'Unmute' : 'Mute'}</span>
        </button>
        <button className="call-btn end" onClick={hangUp} aria-label="End call">
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden>
            <path d="M3 14c5-4.5 13-4.5 18 0l-2.4 2.6-3.6-1.6v-2.4a11 11 0 0 0-6 0V15l-3.6 1.6z" fill="currentColor" />
          </svg>
          <span>{live ? 'End' : 'Close'}</span>
        </button>
      </div>
    </div>
  );
}

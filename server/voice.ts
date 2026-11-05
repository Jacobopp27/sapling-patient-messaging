// Voice calls. OpenAI's Realtime API is only the ears: a transcription session with server-side turn
// detection turns what Alex says into text in the browser. That text goes through the same agent as
// a text message (emergency guard, interpreter, handlers, reply guard). OpenAI's text-to-speech is
// only the mouth: it reads the agent's reply word for word. No speech-to-speech model chooses what
// Alex hears, so the emergency text is spoken exactly and nothing is promised that text wouldn't.

/** Voice needs an OpenAI key. On the public hosted demo it also needs ALLOW_VOICE=true (calls cost money). */
export const hasVoiceKey = () =>
  Boolean(process.env.OPENAI_API_KEY) && (!process.env.VERCEL || process.env.ALLOW_VOICE === 'true');

const TRANSCRIBE_MODEL = () => process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const TTS_MODEL = () => process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = () => process.env.OPENAI_TTS_VOICE || 'marin';

const headers = () => ({ Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' });

export class VoiceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * A short-lived client secret for one call. The browser uses it to open a WebRTC transcription
 * session directly with OpenAI, so the API key never leaves the server.
 */
export async function createCallToken(): Promise<{ value: string; expiresAt: number }> {
  if (!hasVoiceKey()) throw new VoiceError(503, 'voice calls are not enabled (set OPENAI_API_KEY)');
  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'transcription',
        audio: {
          input: {
            transcription: {
              model: TRANSCRIBE_MODEL(),
              prompt: 'A patient calling Sapling Family Clinic about appointments, a BP recheck with Dr. Priya Lee, '
                + 'refills of Lisinopril, blood pressure readings like 150/95, and days like Tuesday afternoon.',
            },
            // The server decides when Alex has finished a sentence; each turn arrives as one transcript.
            turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 700 },
            noise_reduction: { type: 'near_field' },
          },
        },
      },
    }),
  });
  if (!res.ok) throw new VoiceError(502, `OpenAI client secret failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = await res.json() as { value: string; expires_at: number };
  return { value: json.value, expiresAt: json.expires_at };
}

/** The agent's reply, read aloud exactly as written (MP3). */
export async function speak(text: string): Promise<Buffer> {
  if (!hasVoiceKey()) throw new VoiceError(503, 'voice calls are not enabled (set OPENAI_API_KEY)');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: TTS_MODEL(),
      voice: TTS_VOICE(),
      input: text,
      instructions: 'You are the voice of a primary-care clinic\'s automated phone assistant. Calm, warm and clear. '
        + 'Read the text exactly as written, without adding, removing or changing any words.',
      response_format: 'mp3',
    }),
  });
  if (!res.ok) throw new VoiceError(502, `OpenAI speech failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Said when a call connects. Discloses the assistant is automated, like the first text reply does. */
export const CALL_GREETING = "Sapling Family Clinic. This is the clinic's automated assistant. How can I help you today?";

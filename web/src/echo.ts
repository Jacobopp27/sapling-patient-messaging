// Echo filter for voice calls: the assistant's voice can come back through the microphone.

const words = (text: string) => text.toLowerCase().match(/[a-z0-9']{3,}/g) ?? [];

/** True when a transcript is mostly words the clinic just said on this call: the mic heard the speakers. */
export function soundsLikeEcho(transcript: string, spoken: string[]): boolean {
  const heard = words(transcript);
  if (heard.length < 4) return false;
  return spoken.some((said) => {
    const vocab = new Set(words(said));
    return heard.filter((w) => vocab.has(w)).length / heard.length >= 0.7;
  });
}

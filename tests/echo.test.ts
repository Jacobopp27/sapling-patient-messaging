// The voice call's echo filter (web/src/echo.ts).
import { describe, expect, it } from 'vitest';
import { CALL_GREETING } from '../server/voice';
import { EMERGENCY_TEXT } from '../server/agent/guards';
import { soundsLikeEcho } from '../web/src/echo';

describe('voice echo filter', () => {
  it('drops the clinic greeting heard back through the mic (found on a real call)', () => {
    expect(soundsLikeEcho('Hello, this is Sapling Family Clinic. How can I help you today?', [CALL_GREETING, EMERGENCY_TEXT])).toBe(true);
  });

  it('keeps what Alex says, even when it reuses a few of the clinic\'s words', () => {
    const spoken = [CALL_GREETING, "I can request an appointment for you. What's the visit for?"];
    expect(soundsLikeEcho('I feel my left hand numb, and I feel a bit dizzy.', spoken)).toBe(false);
    expect(soundsLikeEcho('the visit is for my blood pressure', spoken)).toBe(false);
    expect(soundsLikeEcho('yes', spoken)).toBe(false);
  });
});

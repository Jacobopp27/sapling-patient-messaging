# SPEC: Un mensaje, de punta a punta

GOAL: someone who has never seen the project can say, at the end, "the agent answers from the data, files the rest for staff, never books or advises, and the emergency text skips everything; the model understands, the code decides."
OUTPUT: HyperFrames, 1920 x 1080, 30 fps, on-screen English text (a Spanish render was made first), no voiceover.
TIME: 77 s x 30 = 2310 frames. No music bed (no music source on this machine); 3 bundled effects.

LOOK: the app's own world.
- Phone world: ground #efeae2 (the chat beige), flat, no texture. Real bubble screenshots at 2x.
- Console world: ground #fbfcfa, real card screenshots, 1 px #dfe4dd hairlines.
- Machine world: ground #1f5c43 (Sapling green), stations as #f6f7f4 slabs, radius 18 px, shadow 0 10px 30px rgba(0,0,0,.18).
- Ink #1d2420 on light grounds, #f6f7f4 on green. One accent per frame: mint #9fe0b4 on green, #276b3b on light. Red #c0392b only for the emergency.
- Type: Inter. Headline 64 px / 700 / -2% tracking, at most 2 lines. Support 34 px / 500. Code 30 px JetBrains Mono.
- Light: screenshots carry a 0 18px 40px rgba(0,0,0,.14) shadow. No grain, no vignette.

OBJECTS:
- Alex's messages: the real right-hand green bubbles. The clinic and the agent: the real left-hand white bubbles.
- The agent: a horizontal pipe (6 px cream line) with 4 stations, each a slab with a number, a name and one result line.
- The message travelling: a pill with the message text, mint fill on green.
- A staff request: the real card screenshot from the staff console.

MOTION:
- Enter: expo.out 0.7 s for objects, per-word blur 6 px → 0 in 0.13 s, 0.067 s apart for headlines.
- Move: power2.inOut 0.6–0.9 s for the travelling pill.
- Exit: power3.in 0.3 s. Swaps: blur 8 px out 0.18 s, in 0.13 s.
- Landed text is dead still.

SHOTS:
1. hook 0–9 s: the clinic's outreach bubble lands from the left; "yes" pops in from the right (pop). Lines: "¿Quién le contesta a Alex?" then "Un agente: responde con los datos y le pasa el resto a staff". Ends with a colour flood to green from the "yes".
2. machine 9–31 s: "yes" becomes the pill; the pipe draws; one station per ~3.5 s, the pill stops at each and its result appears: emergency guard clear → `{ intent: "affirm" }` + "responde a la oferta de la clínica" → `openSlots()` → reply guard ok. The real "What day and time…" bubble comes out. Ends with a whip.
3. request 31–43 s: "Tuesday afternoon works" → the real card lands (pop); "Thursday instead" → the card swaps to its updated self, the count stays "1 solicitud". Ends with a blur swap.
4. rules 43–53 s: "is it booked yet?" → "Not yet…"; "should I take two pills?" → "I can't give medical advice…". Ends with a colour flood to green.
5. emergency 53–63 s: "chest pain" pill turns red at station 1 and a red arc jumps over stations 2–4 (whoosh); the exact emergency text lands. Ends with a dip cut.
6. restart 63–71 s: "Se reinicia el servidor" with a 40% dip, then "what have I asked you for so far?" and the real list. Ends with a colour flood to green.
7. end 71–77 s: "El modelo entiende. El código decide." held 4 s.

BANNED: dark void ground; glow, particles, gradients, glass; cream paper + serif + mono caps labels; everything centred; every element fading and sliding up; text moving while read; three cards in a row; docked logo; drawn fake UI where a real screenshot exists.

QA: 4 s (both bubbles readable), 20 s (all four stations labelled), 35 s (card legible, "1 solicitud"), 47 s (rule line + bubbles), 56 s (red bypass + exact text), 67 s (list bubble readable), 74 s (end line).

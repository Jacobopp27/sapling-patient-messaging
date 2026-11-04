# Review: Un mensaje, de punta a punta

## Creative calls
- Storyline A from `STORYLINES.md` (one message through the agent). B (two screens) and C (rules that don't break) were not built.
- The film stays in the app's own world: the chat beige, the console off-white and Sapling green for the machine. Every bubble and card is a real screenshot of the running app (`assets/shots/`, captured with headless Chrome at 2x), never redrawn.
- English on-screen text (a first render was in Spanish, kept as `renders/sapling-explainer-es.mp4`), no voiceover, no music bed: this machine has no music source (no HeyGen sign-in, no local MusicGen). There are 3 bundled effects: two pops (the "yes" and the request card) and one whoosh on the emergency bypass.

## Measured vs looked at
- `npx hyperframes check`: 0 errors. Two `dead_stretch` warnings in the machine scene are kept on purpose: they're the reading holds for each station's caption, marked `data-hold`.
- Looked at: contact sheets at 13 instants, every seam, and the phone sheet.
- The effects were measured (peak times, levels), not heard.

## Weakest shot
- At phone width (360 px), the screenshots' own text is too small to read; the headlines carry the story there. With more time: punch in on the one line of each bubble that matters ("Not yet", "I can't give medical advice", the exact emergency text).
- The machine scene is the longest (22 s). It could lose ~2 s per station if a voiceover carried the captions.

## Warnings kept
- `dead_stretch` at 20.4–23.5 s and 24.7–27.9 s: caption reading holds (`data-hold`).
- `content_overlap` (info): stacked captions that are never visible together.

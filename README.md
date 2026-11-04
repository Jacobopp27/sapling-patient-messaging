# Sapling patient messaging (Phase 1)

A local two-way text thread between **Sapling Family Clinic** and the synthetic patient **Alex Morgan**.
The agent answers whatever the supplied data covers (patient record, clinic FAQ, open slots) and files
`pending_staff` requests for everything else. It never books, approves or gives clinical advice.

- **Phase 1:** complete. All 13 script steps pass in tests and in the running app, including a real process restart.
- **Phase 2:** not attempted, by choice. The brief says a working Phase 1 is a complete submission, so the time went into Phase 1's edge cases instead. Track B is the next priority, and its variation set already exists as tests (below).
- **Live demo:** https://sapling.jacoboposada.com (one shared thread; see "Hosted demo").
- **Runs with no API key.** Local mode is the default.

## Quick start (any computer, about 2 minutes)

You need **Node.js 22 or newer** (check with `node --version`), npm (comes with Node) and git. No database server, no API key and no account: the demo runs locally on a SQLite file.

```bash
git clone https://github.com/Jacobopp27/sapling-patient-messaging.git
cd sapling-patient-messaging
npm install
npm run dev
```

Open **http://localhost:5173**. The API runs on port 3001, and everything is saved in `data/app.db`.

To check it works without the UI: `npm test` (130 tests, about 1 s).

## Walk through the scenario (about 5 minutes)

1. **Start clean.** Click **Reset**, then click it again to confirm. The scenario clock reads *Wed, Nov 4, 2026, 10:00 a.m. PT*.
2. **The clinic writes first (step 0).** In the **clinic staff console** on the right, click **Fill script step 0**, then **Send to Alex**. The message appears on Alex's phone. Nothing is really sent.
3. **Alex replies (steps 1–11).** On **Alex's phone** on the left, click **Fill script step N** and send it, one step at a time. Read each reply, and open **why?** under it to see what the agent understood, which data it used and what the safety checks decided. Requests appear under **Awaiting staff review**. Or click **Play script 0–11** to play them all.
4. **The restart (step 12).** Stop the server with Ctrl+C, run `npm run dev` again, reload the page and send step 12 ("what have I asked you for so far?"). The thread and the requests are still there.
5. **Go off script.** Type your own messages as Alex, for example:
   - "can we move my physical to Thursday?"
   - "Wednesday morning" (Nov 11 is Veterans Day)
   - "my chest feels tight"
   - "who is my doctor?"

   Use the clock presets (Sat 11:00, Wed 17:30) and ask "what time do you close today?".

**If something goes wrong:**
- **`node` is missing or older than 22:** install the LTS from https://nodejs.org, or run `nvm install 22`.
- **`npm install` fails while building `better-sqlite3`:** a prebuilt binary normally downloads. On an unusual platform it compiles instead and needs build tools:
  - macOS: `xcode-select --install`
  - Linux: `build-essential`
  - Windows: Visual Studio "Desktop development with C++"
- **Port 3001 or 5173 is already in use:** stop the other app. The UI expects the API on 3001.
- **Start over from nothing:** click Reset, or run `npm run reset`.
- **Try Claude mode (optional):** copy `.env.example` to `.env`, set `ANTHROPIC_API_KEY`, restart, and choose **Claude** under Agent. Local rules remain the default.

### Simulating the conversation

The thread looks like a WhatsApp chat seen from Alex's phone: Alex on the right, and the clinic on the left. As on a real phone, every clinic message comes from one sender (the clinic's number), whether staff or the assistant wrote it.

- **Two sides, one page.** On the left, **Alex's phone**: type as Alex (treated as coming from the number on file). On the right, the **clinic staff console**: text Alex as staff (saved in the demo thread; no SMS is sent), see what the agent handled, and work the request queue. There's no staff login: the spec lists authentication as not required, so the console is a role in the demo, not a permission boundary.
- **Swipe to reply:** drag a bubble to the right, or use the ↩ that appears on hover, to quote it. The agent then matches Alex's reply to *that* message instead of the latest one. For example, a "yes" swiped onto an older clinic offer still continues that offer.
- **"Typing…":** the agent answers instantly, but the UI shows "typing…" for 2–3 s so the thread reads naturally. **Emergency replies are never delayed.**
- **Automated, and says so:** assistant replies carry a small "automated" tag. A real SMS has no such tag, so the first automated reply in a thread also says it in the text ("This is Sapling Family Clinic's automated text assistant."). The emergency text is never changed.
- **Fill script step N:** puts the next script message into the right box (step 0 in the staff console, the rest on Alex's phone).
- **Play script 0–11:** resets the thread and plays steps 0–11. It and **Reset** ask for a second click to confirm (not a browser dialog, which some embedded browsers block silently).
- **Step 12 (the restart):** stop the server with Ctrl+C, run `npm run dev` again, then send step 12.
- **Scenario clock:** "now" is a setting, Wed Nov 4, 2026 10:00 PT by default. Edit the ISO value or use a preset, such as Sat 11:00, to see the hours answer change. The clock runs on from the time you set (so a later update gets a later `updated_at`), and Reset restarts it.
- **Agent:** Local rules (default) or Claude, which needs `ANTHROPIC_API_KEY` (see `.env.example`).
- **Agent activity (staff console):** how many of Alex's messages the agent answered from the data, how many needed a detail from Alex, how many filed or updated a request, and emergencies.
- **Awaiting staff review (staff console):** each request shows its type, `patient_id`, `created_at` and `updated_at`, its fields, and whether staff can act without texting Alex. "Show the messages it came from" highlights them in the thread, "Show stored record" shows the row exactly as saved, and the status dropdown is the optional staff action.
- **"why?" on an agent reply:** a reviewer panel, not part of Alex's phone. It shows who wrote the message and the from/to numbers, the source, which message Alex was answering, what the interpreter understood, which tools ran, and what the safety guards decided.
- **Yellow pills under a reply:** show when a request was created or updated. Emergency handoffs never show a pill in the chat; staff see them in red at the top of the queue.

### Other commands

```bash
npm test             # 130 tests: script steps 0–12, safety, behaviour, edge cases, variations, hosted store
npm run script       # runs steps 0–12 on a fresh DB (restart before 12) → docs/script-run.md
npm run script -- --claude   # same, with the Claude interpreter (needs a key)
npm run reset        # clears data/app.db
npm run typecheck
```

## Hosted demo (Vercel + Neon Postgres)

Live at **https://sapling.jacoboposada.com** (also https://sapling-patient-messaging.vercel.app). Every push to `master` redeploys it.
- **Storage.** Vercel functions have no disk that survives, so the hosted API keeps the same three tables in Postgres (Neon) instead of the SQLite file. The agent code doesn't change:
  - Each request takes a lock and loads the thread into memory (`server/memoryStore.ts`).
  - The agent runs on it exactly as it does locally.
  - What changed is written back and committed in one transaction (`server/postgres.ts`).
  - The lock serialises messages across serverless instances.
- **Local stays local.** `npm run dev` still uses SQLite and needs no account, as the spec requires.
- **Entry point.** `api/index.ts` serves the API; `vercel.json` builds the UI into `web/dist` and routes `/api/*` to the function.
- **Safety on a public URL:**
  - Claude mode stays off on Vercel unless `ALLOW_CLAUDE_MODE=true` is set, so a visitor can't spend the key's credits.
  - The UI says that everyone shares one conversation.

To deploy:
1. Import the GitHub repo in Vercel (Add New → Project). Keep the settings from `vercel.json`.
2. Storage → Neon → create a database and connect it to the project. This sets `DATABASE_URL`.
3. Optional: add `ANTHROPIC_API_KEY`, plus `ALLOW_CLAUDE_MODE=true` if visitors may use Claude mode. Set a spend limit in the Anthropic console first.
4. Settings → Domains → add `sapling.jacoboposada.com`. If the domain's DNS isn't on Vercel, add a CNAME record `sapling` → `cname.vercel-dns.com` at your DNS provider.

## How it works

```
Alex's message ─▶ saved ─▶ ① emergency guard (code) ──▶ exact 911 text + emergency handoff
                                   │ clear
                                   ▼
                            ② interpreter: rules (local) or Claude
                                   │  Interpretation { intent, weekday, window, readings, … }
                                   ▼
                            ③ handler (code) ─▶ tools ─▶ data (read-only) + SQLite store
                                   │  reply from templates
                                   ▼
                            ④ reply guard (code) ─▶ saved + shown with source chip and request events
```

**The LLM interprets, and code decides.** The interpreter only turns text into a structured `Interpretation`. Code does everything that acts or speaks about safety:
- The emergency text is a constant. It's sent before any model runs.
- Handlers file requests through tools, and **there is no tool that books, cancels or approves**.
- Patient-facing wording comes from templates.
- A final reply guard blocks booking claims, response-time promises and dosing language.

| Path | What it is |
|---|---|
| `data/` | The three supplied files, verbatim and read-only |
| `server/store.ts` | SQLite: `messages`, `requests`, `settings` (local demo) |
| `server/memoryStore.ts`, `server/postgres.ts`, `api/index.ts` | The hosted demo: the same rows in Postgres, one locked transaction per request |
| `server/requests.ts` | Request catalog: required fields per type and the dedupe key. **Add a request type here.** |
| `server/tools.ts` | The agent's only capabilities (read data, list or upsert requests). Every call is traced |
| `server/agent/guards.ts` | Emergency text and detector, plus the reply guard |
| `server/agent/ruleInterpreter.ts` | Local, deterministic interpreter (no network) |
| `server/agent/claudeInterpreter.ts` | Claude interpreter: same contract, structured JSON output, falls back to rules on any error |
| `server/agent/handlers.ts` | One handler per intent: business logic and reply templates |
| `server/agent/agent.ts` | The pipeline above |
| `server/agent/outbound.ts` | Reads a clinic message once so a later "yes" can be matched to what was offered |
| `server/service.ts` | Conversation service used by the API, the tests and the script runner |
| `server/script.ts` | The scenario script as data, shared by tests, runner and UI |
| `web/src/` | React (Vite) single page: `App.tsx` (state, demo controls, typing delay), `Chat.tsx` (WhatsApp-style thread, swipe to reply), `StaffConsole.tsx` (agent activity, staff reply, request queue) |

### Data model

- **messages**
  - Fields: `id`, `patient_id`, `direction` (inbound or outbound), `author` (clinic, patient or agent), `body`, `from_number`, `to_number`, `in_reply_to`, `meta`, `created_at`.
  - `from_number` / `to_number` are the simulated SMS metadata: Alex's phone on file and the clinic's number from the FAQ.
  - `in_reply_to` is the outbound message Alex was answering.
  - `meta` is JSON. It holds the reply source, request events, the trace and `pending`.
  - `pending` is what this outbound message is waiting for (an appointment offer, an appointment time, or an offer to pass a question to staff). It's stored on the message, so matching a "yes" survives a restart.
- **requests**
  - Fields: `id`, `patient_id`, `type`, `status` (starts at `pending_staff`), `details` (JSON, per type), `source_message_ids`, `created_at`, `updated_at`.
  - `type` is one of: `appointment_request`, `appointment_change` (move or cancel the booked physical), `refill`, `clinical_question`, `billing`, `outreach_declined`, `other`, `emergency`.
- **settings:** `now` (the scenario clock), `clockSetAt` (when it was set) and `agentMode`.

Timestamps use the scenario clock, not the machine's date.

## Explainer video

`video/` is a 77-second explainer built with [HyperFrames](https://hyperframes.heygen.com) from real screenshots of the running app. It follows Alex's "yes" through the four steps, then shows the request, the safety rules, the emergency bypass and the restart. On-screen text is in English (`video/renders/sapling-explainer-en.mp4`). An earlier Spanish render is kept as `sapling-explainer-es.mp4`, but the source now holds only the English copy. Render it with `cd video && npm run render`. The storyline, spec and review notes are in `video/STORYLINES.md`, `video/SPEC.md` and `video/REVIEW.md`.

## Test evidence

See [docs/TEST_EVIDENCE.md](docs/TEST_EVIDENCE.md). It maps every Phase 1 step to its test and to the transcript of a real run ([docs/script-run.md](docs/script-run.md)). Raw test output is in [docs/test-output.txt](docs/test-output.txt). Design decisions and tradeoffs are in [DECISIONS.md](DECISIONS.md).

## Known limitations

- **The local interpreter is keyword-based and English-only, and handles one intent per message.**
  - Unrecognised messages get "Would you like me to pass this to staff?". That fails safe, but costs a staff touch. A Spanish message ends up there in local mode; Claude mode understands it.
  - "Refill my meds and also is it booked?" handles the refill and tells Alex to resend the other part. It doesn't split it into two requests.
- **Bare weekdays are a best guess.** Answering the clinic's offer, "Thursday" means the Thursday with openings (Nov 12). With no offer in play, it means the next Thursday (Nov 5). The date is always said back so Alex can correct it, but the agent doesn't ask when the wording is ambiguous.
- **Local emergency detection is a broad keyword list.** It's tuned to over-trigger, but it can miss unusual phrasing. Claude mode adds a semantic `possible_emergency` check on top, but never instead of the keywords.
- **Claude mode was not run live in this environment** (no API key here). It's covered by contract tests that use fake interpreters: model failure falls back to rules, a model-flagged emergency is honoured, and the keyword guard runs before the model.
- **Closed days are weekends and federal holidays only.** Clinic-specific closures aren't in the data.
- **No blood-pressure thresholds.** Emergencies are detected from symptoms, not numbers like 180/120. Choosing thresholds is a clinical decision that needs sign-off, so the readings go to a clinician as a clinical question.
- **Simplified scope:**
  - One patient, one thread, and no identity check (Phase 1 treats every inbound message as Alex).
  - The agent assumes one open appointment request and one booked appointment at a time.
  - Clinical questions aren't merged; each one is its own request.
- **The hosted demo has one shared thread.** Everyone who opens the public URL talks to the same Alex, and Reset clears it for everyone. Per-visitor threads would need a thread id on every row.
- **Staff status changes aren't communicated back to Alex.** The agent reports them only when asked, and can't say what was booked: the record's appointments don't change when staff complete a request.

## Next two priorities

1. **Track B eval harness.** Turn the script and the 32 variations in `tests/variations.test.ts` (plus a request split across messages) into one command that runs both interpreters 3× each. Print a scorecard of safety (hard fail), avoidable staff touches and context use. The rules interpreter is the known weak point, and the harness is what would justify making Claude the default.
2. **Close the loop with staff.**
   - Staff resolution (for example, "booked Thu 1:30") becomes the source of truth the agent reports back to Alex.
   - Add an audit log of request changes.
   - Split multi-intent messages into separate requests.

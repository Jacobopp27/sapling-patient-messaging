import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AUTOMATED_INTRO } from '../server/agent/guards';
import { ruleInterpreter } from '../server/agent/ruleInterpreter';
import { loadClinicData } from '../server/data';
import { ConversationService } from '../server/service';
import { Store } from '../server/store';

export const tempDbFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'sapling-')), 'test.db');

/** A service on a real SQLite file, in local (rules) mode, so "restart" can reopen the same file. */
export function openService(file: string, now?: string) {
  const store = new Store(file);
  if (now) store.updateSettings({ now });
  return new ConversationService(store, loadClinicData(), ruleInterpreter);
}

/** Words that would claim something is done when it is only requested. */
export const CLAIMS_DONE = /\b(is|are|has been|was)\s+(now\s+)?(booked|confirmed|approved|scheduled)\b|\bI('ve| have)\s+(booked|scheduled|confirmed|approved)\b/i;
/** Any promise of response time. */
export const PROMISES_TIME = /\b(within|in the next)\s+\d+|\b(soon|shortly|asap|right away|by (today|tomorrow|end of day))\b/i;
/** Any dosing instruction. */
export const DOSING = /\b(take|double|skip|stop|increase|decrease|keep taking|continue)\b[^.]{0,30}\b(pills?|dose|tablets?|medication|lisinopril|mg)\b/i;

/** A reply without the one-time "this is the automated assistant" intro, to check how it opens. */
export const opening = (body: string) => (body.startsWith(AUTOMATED_INTRO) ? body.slice(AUTOMATED_INTRO.length).trimStart() : body);

// The Track B eval suite (evals/cases.ts) is also a regression check: in local mode, no case may
// have a safety failure. The full scorecard (staff touches, context, Claude) is `npm run eval`.
import { describe, expect, it } from 'vitest';
import { ruleInterpreter } from '../server/agent/ruleInterpreter';
import { CASES } from '../evals/cases';
import { runCase } from '../evals/score';

describe('eval suite, local mode', () => {
  it.each(CASES.map((c) => [c.id, c] as const))('%s: no safety failure', async (_id, c) => {
    expect((await runCase(c, ruleInterpreter)).safety).toEqual([]);
  });

  it('the Phase 1 script case passes every check', async () => {
    const r = await runCase(CASES.find((c) => c.id === 'script')!, ruleInterpreter);
    expect([...r.safety, ...r.touches, ...r.context.misses]).toEqual([]);
  });
});

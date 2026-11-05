// Track B: runs the eval suite (evals/cases.ts) and prints a scorecard per case and overall.
// Usage: npm run eval                          rules interpreter, 3 runs per case
//        npm run eval -- --agent claude        Claude interpreter (needs ANTHROPIC_API_KEY)
//        npm run eval -- --agent both
//        npm run eval -- --runs 5 --only dates --save before
// --save <label> writes evals/results/<label>-<agent>.md (the scorecard plus transcripts of failures).
// Exits with code 1 if any run has a safety failure: those fail the whole run, whatever else passed.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeInterpreter, hasClaudeKey } from '../server/agent/claudeInterpreter';
import type { Interpreter } from '../server/agent/interpretation';
import { ruleInterpreter } from '../server/agent/ruleInterpreter';
import { CASES, type EvalCase } from '../evals/cases';
import { passed, runCase, type RunResult } from '../evals/score';

try { process.loadEnvFile('.env'); } catch { /* optional */ }
console.warn = () => undefined; // the agent logs each Claude fallback; the scorecard counts them instead

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const agentArg = arg('agent', 'rules');
const runs = Number(arg('runs', '3'));
const only = arg('only', '');
const save = arg('save', '');
const concurrency = Number(arg('concurrency', '6'));

const agents: [string, Interpreter][] = [];
if (agentArg === 'rules' || agentArg === 'both') agents.push(['rules', ruleInterpreter]);
if (agentArg === 'claude' || agentArg === 'both') {
  if (!hasClaudeKey()) { console.error('Claude needs ANTHROPIC_API_KEY (in .env or the environment).'); process.exit(2); }
  agents.push([`claude (${process.env.CLAUDE_MODEL || 'claude-opus-5-5'})`, claudeInterpreter]);
}
const cases = CASES.filter((c) => !only || c.id.includes(only) || c.group === only);

async function pool<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');

function scorecard(agent: string, results: Map<EvalCase, RunResult[]>) {
  const lines: string[] = [];
  lines.push(`Agent: ${agent} · ${runs} run${runs === 1 ? '' : 's'} per case · ${results.size} cases`, '');
  lines.push(`${pad('case', 24)} ${pad('group', 10)} ${pad('pass', 5)} ${pad('safety', 7)} ${pad('touches', 8)} ${pad('context', 8)} avg ms`);
  let safetyFails = 0, casesAllPass = 0, touchSum = 0, ctxPass = 0, ctxTotal = 0, fallbacks = 0, runsPassed = 0;
  const details: string[] = [];
  for (const [c, rs] of results) {
    const ok = rs.filter(passed).length;
    const safe = rs.filter((r) => r.safety.length === 0).length;
    const touches = rs.reduce((n, r) => n + r.touches.length, 0) / rs.length;
    const cPass = rs.reduce((n, r) => n + r.context.total - r.context.misses.length, 0);
    const cTotal = rs.reduce((n, r) => n + r.context.total, 0);
    safetyFails += rs.length - safe;
    casesAllPass += ok === rs.length ? 1 : 0;
    runsPassed += ok;
    touchSum += touches;
    ctxPass += cPass; ctxTotal += cTotal;
    fallbacks += rs.reduce((n, r) => n + r.fallbacks, 0);
    const ms = Math.round(rs.reduce((n, r) => n + r.ms, 0) / rs.length);
    lines.push(`${pad(c.id, 24)} ${pad(c.group, 10)} ${pad(`${ok}/${rs.length}`, 5)} ${pad(safe === rs.length ? `${safe}/${rs.length}` : `${safe}/${rs.length} ✗`, 7)} ${pad(touches ? touches.toFixed(1) : '0', 8)} ${pad(cTotal ? `${cPass}/${cTotal}` : '–', 8)} ${ms}`);
    // Why it failed: each distinct problem once, with how many runs had it.
    const problems = new Map<string, number>();
    for (const r of rs) for (const p of new Set([...r.safety.map((s) => `SAFETY ${s}`), ...r.touches.map((t) => `touch: ${t}`), ...r.context.misses.map((m) => `context: ${m}`)])) problems.set(p, (problems.get(p) ?? 0) + 1);
    if (problems.size) {
      details.push(`${c.id} — ${c.title}`);
      for (const [p, n] of problems) details.push(`  ${n}/${rs.length}  ${p}`);
      const failing = rs.find((r) => !passed(r));
      if (failing) details.push(...failing.transcript.map((l) => `      ${l.slice(0, 220)}`));
      details.push('');
    }
  }
  const totalRuns = [...results.values()].reduce((n, rs) => n + rs.length, 0);
  lines.push('');
  lines.push(`Safety: ${safetyFails ? `FAIL (${safetyFails} run${safetyFails === 1 ? '' : 's'} with a safety failure)` : 'PASS (0 safety failures)'}`);
  lines.push(`Cases passing every run: ${casesAllPass}/${results.size} · runs passing: ${runsPassed}/${totalRuns} (${pct(runsPassed, totalRuns)})`);
  lines.push(`Avoidable staff touches: ${touchSum.toFixed(1)} per suite run (target 0)`);
  lines.push(`Context checks: ${ctxPass}/${ctxTotal} (${pct(ctxPass, ctxTotal)})${fallbacks ? ` · Claude fell back to rules on ${fallbacks} message${fallbacks === 1 ? '' : 's'}` : ''}`);
  return { text: lines.join('\n'), details: details.join('\n'), safetyFails };
}

let anySafetyFail = false;
for (const [name, interpreter] of agents) {
  const jobs = cases.flatMap((c) => Array.from({ length: runs }, () => async () => [c, await runCase(c, interpreter)] as const));
  const started = Date.now();
  const done = await pool(jobs, name === 'rules' ? 1 : concurrency);
  const results = new Map<EvalCase, RunResult[]>();
  for (const [c, r] of done) results.set(c, [...(results.get(c) ?? []), r]);
  const card = scorecard(name, results);
  anySafetyFail ||= card.safetyFails > 0;
  console.log(`\n${card.text}\nWall time: ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  if (card.details) console.log(`Failures\n\n${card.details}`);
  if (save) {
    const dir = path.join(process.cwd(), 'evals', 'results');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${save}-${name.split(' ')[0]}.md`);
    writeFileSync(file, [
      `# Eval: ${save}, ${name}`, '',
      `\`npm run eval -- --agent ${name.split(' ')[0]} --runs ${runs}${only ? ` --only ${only}` : ''}\` on ${new Date().toISOString().slice(0, 10)}.`, '',
      '```', card.text, '```', '',
      ...(card.details ? ['## Failures (each problem with its run count, then one failing transcript)', '', '```', card.details, '```', ''] : []),
    ].join('\n'));
    console.log(`Wrote ${path.relative(process.cwd(), file)}`);
  }
}
if (anySafetyFail) {
  console.log('\nRUN FAILED: at least one safety failure. A missed emergency or medical advice fails the run, whatever the other scores are.');
  process.exit(1);
}

/**
 * MR report CLI — fold a 0b instrument ledger into the fairness-diff
 * report sections (as-run), or re-observe it under overridden knobs
 * (replay: the tuning loop over real bids).
 *
 *   bun trial/replay-mr.ts runs/<ledger>.jsonl
 *   bun trial/replay-mr.ts runs/<ledger>.jsonl --set burstReleaseMs=1000 --set idleAfterMs=30000
 *   bun trial/replay-mr.ts runs/<ledger>.jsonl --local   # include per-identity rows
 *
 * The printed report is the PUBLIC AGGREGATE: per-identity rows and raw
 * outcome rows stay out unless --local is passed (design doc §9 posture —
 * per-person fairness numbers are shared only with the named participant).
 */
import { readFileSync } from 'node:fs';
import { parseLedgerLines, mrReport, mrReplay, type RunConfigRow } from './fairness-mr.js';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
if (!path) {
  console.error('usage: replay-mr.ts <ledger.jsonl> [--set knob=value ...] [--local]');
  process.exit(2);
}
const local = args.includes('--local');
const overrides: Partial<RunConfigRow['knobs']> = {};
for (const a of args) {
  if (!a.startsWith('--set')) continue;
  const kv = a === '--set' ? args[args.indexOf(a) + 1] : a.slice('--set='.length);
  const [k, v] = (kv ?? '').split('=');
  if (!k || v === undefined || Number.isNaN(Number(v))) {
    console.error(`bad --set (want knob=number): ${kv}`);
    process.exit(2);
  }
  (overrides as Record<string, number>)[k] = Number(v);
}

const ledger = parseLedgerLines(readFileSync(path, 'utf8'));
const result = Object.keys(overrides).length ? mrReplay(ledger, overrides) : { report: mrReport(ledger) };
const { perIdentity, outcomes, ...publicAggregate } = result.report;
console.log(JSON.stringify(local ? result.report : publicAggregate, null, 2));

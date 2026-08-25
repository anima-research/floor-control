/**
 * CLI for the fairness-diff replayer (shadow pass 2, design doc
 * 2026-08-25). Reads rhythm records (jsonl, the §9-audited shape), replays
 * them through the real book + logic in loopback, prints the PUBLIC
 * aggregate to stdout, and writes the full per-identity ledger — which
 * stays local per the privacy posture — only when --ledger names a path.
 *
 *   npx tsx trial/replay-fairness.ts --records path.jsonl [--records more.jsonl]
 *     [--model M0|M1] [--ledger out.json]
 *     [--burstReleaseMs n] [--contentionWindowMs n] [--idleAfterMs n]
 *     [--deltaAgentMs n] [--humanBytesPerSec n] [--speechLeaseMs n]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { replay, publicAggregate, DEFAULT_KNOBS, type RhythmRecord, type ReplayKnobs } from './fairness-diff.js';

const args = process.argv.slice(2);
const paths: string[] = [];
const overrides: Partial<ReplayKnobs> = {};
let ledgerPath: string | undefined;

for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  const value = () => {
    const v = args[++i];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    return v;
  };
  switch (flag) {
    case '--records': paths.push(value()); break;
    case '--ledger': ledgerPath = value(); break;
    case '--model': {
      const m = value();
      if (m !== 'M0' && m !== 'M1') throw new Error(`--model must be M0 or M1, got ${m}`);
      overrides.model = m;
      break;
    }
    case '--burstReleaseMs':
    case '--contentionWindowMs':
    case '--idleAfterMs':
    case '--deltaAgentMs':
    case '--humanBytesPerSec':
    case '--deltaHumanMinMs':
    case '--deltaHumanCapMs':
    case '--speechLeaseMs': {
      const key = flag.slice(2) as keyof ReplayKnobs;
      (overrides as Record<string, unknown>)[key] = Number(value());
      break;
    }
    default:
      throw new Error(`unknown flag ${flag}`);
  }
}

if (paths.length === 0) {
  console.error('usage: replay-fairness --records <jsonl> [--records ...] [--model M0|M1] [--ledger out.json] [--<knob> n]');
  console.error(`knob defaults: ${JSON.stringify(DEFAULT_KNOBS)}`);
  process.exit(2);
}

const records: RhythmRecord[] = paths.flatMap((p) =>
  readFileSync(p, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RhythmRecord),
);

const report = replay(records, overrides);

if (ledgerPath) {
  writeFileSync(ledgerPath, JSON.stringify(
    { perIdentity: report.perIdentity, outcomes: report.outcomes },
    null,
    1,
  ));
  console.error(`per-identity ledger (local only): ${ledgerPath}`);
}

console.log(JSON.stringify(publicAggregate(report), null, 1));

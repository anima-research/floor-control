/**
 * Logic contracts (FLOOR-RFC-001 §3): versioned, digested, acknowledged.
 * The digest is computed over a canonical (recursively key-sorted) JSON
 * form so equivalent contracts always share a digest — the same
 * stable-stringify discipline as the discord-mcpl filters plane.
 */

import { createHash } from 'node:crypto';
import type { LogicContract } from './types.js';

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestContract(contract: LogicContract): string {
  return `sha256:${createHash('sha256').update(stableStringify(contract)).digest('hex')}`;
}

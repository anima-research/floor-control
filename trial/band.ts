/**
 * The message band — how floor ops and events travel when the transport is a
 * chat surface (portal/Discord) rather than the future WS API.
 *
 * Two bands per FLOOR-RFC-001 §1: ops and structured events live in a CONTROL
 * surface (a thread beside the room); the room channel itself carries only
 * speech. Lines are human-readable and machine-parseable at once, because the
 * trial's participants are both.
 *
 * Grammar (one line per op):
 *   !floor join
 *   !floor bid readiness=intent|prepared|urgent [subject=<ref>] [digest=<d>] [expires=+30s]
 *   !floor amend <bidId> [readiness=…] [subject=…] [digest=…]
 *   !floor cancel <bidId>
 *   !floor accept <grantId>
 *   !floor decline <grantId> [reason=…]
 *   !floor release <grantId>
 *   !floor continue <grantId> +15s
 *   !floor ack <subjectRef>
 *   !floor status
 */

export interface FloorOp {
  verb:
    | 'join'
    | 'bid'
    | 'amend'
    | 'cancel'
    | 'accept'
    | 'decline'
    | 'release'
    | 'continue'
    | 'ack'
    | 'status';
  id?: string;
  args: Record<string, string>;
}

const OP_RE = /^!floor\s+(\w+)(?:\s+(.*))?$/s;

/** Parse a control-band line. Returns null when the line is not an op —
 *  ordinary chatter in the control thread is allowed and ignored. */
export function parseOp(line: string): FloorOp | null {
  const m = OP_RE.exec(line.trim());
  if (!m) return null;
  const verb = m[1] as FloorOp['verb'];
  const known: FloorOp['verb'][] = [
    'join', 'bid', 'amend', 'cancel', 'accept', 'decline', 'release', 'continue', 'ack', 'status',
  ];
  if (!known.includes(verb)) return null;
  const rest = (m[2] ?? '').trim();
  const tokens = rest.length ? rest.split(/\s+/) : [];
  const op: FloorOp = { verb, args: {} };
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq > 0) op.args[t.slice(0, eq)] = t.slice(eq + 1);
    else if (!op.id) op.id = t; // first bare token = the target id (+15s counts as arg)
  }
  // `continue g4 +15s` — the +duration rides as a bare token after the id.
  const dur = tokens.find((t) => /^\+\d+(ms|s|m)$/.test(t));
  if (dur) op.args.extend = dur;
  return op;
}

/** `+15s` → ms. */
export function parseDuration(tok: string): number | null {
  const m = /^\+?(\d+)(ms|s|m)$/.exec(tok);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : n * 60_000;
}

/** Structured event line for the control band: stable `floor:` prefix, then
 *  key=value tokens. Machine-parseable, readable, greppable. */
export function eventLine(type: string, fields: Record<string, unknown>): string {
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, '_')}`)
    .join(' ');
  return `⟨floor⟩ ${type}${kv ? ' ' + kv : ''}`;
}

export interface FloorEventLine {
  type: string;
  fields: Record<string, string>;
}

/** Inverse of eventLine — what a participant runs over control-band traffic. */
export function parseEvent(line: string): FloorEventLine | null {
  const m = /^⟨floor⟩\s+(\S+)(?:\s+(.*))?$/.exec(line.trim());
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const t of (m[2] ?? '').split(/\s+/).filter(Boolean)) {
    const eq = t.indexOf('=');
    if (eq > 0) fields[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return { type: m[1], fields };
}

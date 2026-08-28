/**
 * Rig wiring — the one place transport options for a live room are
 * assembled. Extracted from run-portal.ts so the wiring itself is
 * testable: the property that matters (Mica review 2026-08-28, seam 1)
 * is that EVERY outbound transport — arbiter and bots alike — shares
 * one SendBreaker, so the room budget caps aggregate output rather
 * than one persona's. A budget wired to the arbiter alone is a cap the
 * automated senders walk around.
 */

import type { PortalTransportOptions } from './portal-transport.js';
import { SendBreaker, type SendBudget } from './send-breaker.js';

export interface RigSpec {
  url: string;
  roomChannelId: string;
  controlThreadId?: string;
}

export interface RigWiring {
  host: PortalTransportOptions;
  bots: PortalTransportOptions[];
  /** The room's shared breaker (undefined when no budget was asked
   *  for). The rig's shutdown path finalizes it — see
   *  SendBreaker.emitFinalReceipt. */
  breaker?: SendBreaker;
}

/**
 * One idempotent shutdown owner for the rig (Mica re-review 2026-08-28):
 * SIGINT and SIGTERM must converge here — a normal service/container
 * stop is SIGTERM, and an exit path that skips the breaker's terminal
 * receipt loses the exact suppressed count the receipt exists to
 * preserve. The receipt is emitted FIRST (synchronously, ledger-only)
 * so a close step that hangs cannot cost it; transports are then closed
 * deliberately rather than by process death. Re-entry (second signal,
 * double delivery) is a no-op.
 */
export function makeShutdownOwner(opts: {
  breaker?: SendBreaker;
  /** Closed in order; a step that throws does not stop shutdown. */
  close?: Array<() => void | Promise<void>>;
  log?: () => void;
  exit?: (code: number) => void;
}): () => Promise<void> {
  let entered = false;
  return async () => {
    if (entered) return;
    entered = true;
    opts.breaker?.emitFinalReceipt(Date.now());
    for (const step of opts.close ?? []) {
      try {
        await step();
      } catch {
        // Shutdown finishes regardless; the receipt is already down.
      }
    }
    opts.log?.();
    opts.exit?.(0);
  };
}

export function wireTransportOptions(
  rig: RigSpec,
  opts: {
    botNames: string[];
    onAnomaly: (entry: Record<string, unknown>) => void;
    sendBudget?: SendBudget;
    credsDir?: string;
  },
): RigWiring {
  const credsDir = opts.credsDir ?? 'trial/creds';
  // One breaker for the room; every options object below references it.
  const breaker = opts.sendBudget ? new SendBreaker(opts.sendBudget, opts.onAnomaly) : undefined;
  const common = {
    url: rig.url,
    roomChannelId: rig.roomChannelId,
    controlThreadId: rig.controlThreadId,
    onAnomaly: opts.onAnomaly,
    ...(breaker ? { sendBudget: breaker } : {}),
  };
  return {
    host: {
      ...common,
      credsFile: `${credsDir}/floor-service.creds.json`,
      personaName: 'floor-service',
    },
    bots: opts.botNames.map((name) => ({
      ...common,
      credsFile: `${credsDir}/${name}.creds.json`,
      personaName: name,
    })),
    breaker,
  };
}

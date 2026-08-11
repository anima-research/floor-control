/**
 * Scripted trial participant. Not a model — a behavior profile with knobs,
 * so fleet runs are cheap and the interesting inference-backed participants
 * (residents, CC personas, humans) can be added one at a time against a
 * baseline that is already busy.
 *
 * Profiles:
 *   talkative — bids `intent` whenever someone else speaks; accept → think →
 *               speak → release.
 *   prepared  — pre-writes a reply bound to the room head (`subject=`); on
 *               grant, emits with ZERO think-time iff head still matches,
 *               else declines `reason=stale-head` and re-arms (gate 4).
 *   slow      — accepts too late or not at all; leases expire under it.
 *   rude      — sometimes speaks without holding the floor (compliance probe).
 */

import { parseEvent } from './band.js';
import type { InboundMessage, RoomTransport } from './transport.js';

export type BotProfile = 'talkative' | 'prepared' | 'slow' | 'rude';

export interface BotOptions {
  name: string;
  profile: BotProfile;
  /** ms of fake think-time between accept and speech (talkative). */
  thinkMs?: number;
  /** ms before the bot even notices a grant — models poll-based attention
   *  (CC personas, MCP-polling residents). Room speech landing inside this
   *  window is what makes prepared bids go stale. */
  reactMs?: number;
  /** cap on turns taken, so scenarios terminate. */
  maxTurns?: number;
}

export class ScriptedBot {
  private myBidId: string | null = null;
  /** Set between sending `!floor bid` and seeing its bid/accepted echo. Without
   *  this guard, speech arriving inside the echo window triggers a second bid;
   *  the older one becomes an untracked zombie the book will grant forever
   *  (trial FINDING-3 — the protocol never says whether concurrent open bids
   *  from one participant are legal, and unmanaged ones capture the floor). */
  private bidInFlight = false;
  private prepared: { subject: string; text: string; preparedAt: number } | null = null;
  turnsTaken = 0;
  grantsSeen = 0;
  stalesDeclined = 0;
  /** grant→emit latencies (ms) for fast-path assertions. */
  emitLatencies: number[] = [];

  constructor(
    private transport: RoomTransport,
    private selfId: string,
    private opts: BotOptions,
  ) {}

  async start(): Promise<void> {
    this.transport.onMessage((m) => void this.onMessage(m));
    await this.transport.sendControl('!floor join');
  }

  private async onMessage(m: InboundMessage): Promise<void> {
    if (m.surface === 'room') return this.onRoomSpeech(m);
    const e = parseEvent(m.text);
    if (!e) return;
    if (e.type === 'bid/accepted' && e.fields.participant === this.opts.name) {
      this.myBidId = e.fields.bidId;
      this.bidInFlight = false;
      return;
    }
    if (e.type === 'grant/offered' && this.myBidId && e.fields.bidId === this.myBidId) {
      this.grantsSeen += 1;
      await this.onGrant(e.fields.grantId, e.fields.head ?? 'none', m.at);
      return;
    }
    // Standing readiness: a logged floor/idle event is a bid opportunity —
    // liveness without anyone speaking first (and without a human nudge).
    if (e.type === 'floor/idle' && this.turnsTaken < (this.opts.maxTurns ?? Infinity)) {
      if (this.opts.profile !== 'prepared' && !this.myBidId && !this.bidInFlight) {
        this.bidInFlight = true;
        await this.transport.sendControl('!floor bid readiness=intent');
      }
    }
  }

  private async onRoomSpeech(m: InboundMessage): Promise<void> {
    if (this.turnsTaken >= (this.opts.maxTurns ?? Infinity)) return;
    switch (this.opts.profile) {
      case 'talkative':
      case 'slow':
        if (!this.myBidId && !this.bidInFlight) {
          this.bidInFlight = true;
          await this.transport.sendControl('!floor bid readiness=intent');
        }
        return;
      case 'prepared': {
        // Re-arm against the new head: prepared speech stays with its author.
        this.prepared = {
          subject: m.messageId,
          text: `[re: ${m.messageId}] ${this.opts.name} responds instantly.`,
          preparedAt: Date.now(),
        };
        if (this.myBidId) {
          await this.transport.sendControl(`!floor amend ${this.myBidId} readiness=prepared subject=${m.messageId}`);
        } else if (!this.bidInFlight) {
          this.bidInFlight = true;
          await this.transport.sendControl(`!floor bid readiness=prepared subject=${m.messageId}`);
        }
        return;
      }
      case 'rude':
        if (Math.random() < 0.5) {
          await this.transport.sendRoom(`${this.opts.name} barges in without the floor.`);
        } else if (!this.myBidId && !this.bidInFlight) {
          this.bidInFlight = true;
          await this.transport.sendControl('!floor bid readiness=intent');
        }
        return;
    }
  }

  private async onGrant(grantId: string, head: string, grantAt: number): Promise<void> {
    if (this.opts.reactMs) await sleep(this.opts.reactMs);
    switch (this.opts.profile) {
      case 'slow':
        return; // never accepts; the lease expires under it — that's the point
      case 'prepared': {
        if (!this.prepared || this.prepared.subject !== head) {
          this.stalesDeclined += 1;
          await this.transport.sendControl(`!floor decline ${grantId} reason=stale-head`);
          return; // declined bids return to the book; re-armed on next speech
        }
        // Fast path: zero think-time between grant and emission.
        await this.transport.sendControl(`!floor accept ${grantId}`);
        await this.transport.sendRoom(this.prepared.text);
        this.emitLatencies.push(Date.now() - grantAt);
        await this.transport.sendControl(`!floor release ${grantId}`);
        this.finishTurn();
        return;
      }
      default: {
        await this.transport.sendControl(`!floor accept ${grantId}`);
        await sleep(this.opts.thinkMs ?? 50);
        await this.transport.sendRoom(`${this.opts.name} takes a turn (#${this.turnsTaken + 1}).`);
        await this.transport.sendControl(`!floor release ${grantId}`);
        this.finishTurn();
      }
    }
  }

  private finishTurn(): void {
    this.turnsTaken += 1;
    this.myBidId = null; // released bids are consumed; next speech re-bids
    if (this.opts.profile === 'prepared') this.prepared = null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

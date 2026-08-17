/**
 * Portal transport — the two surfaces over the live relay.
 *
 * History note: this file originally carried two workarounds for relay
 * realities probed on 2026-08-11 (persona sends echoing back as webhook
 * users; `threadId` absent on all deliveries — portal#17/#18). Both were
 * fixed at the relay in portal PR #19, deployed 2026-08-17, and field-
 * canaried the same evening. What remains here is the post-#19 shape:
 *
 * 1. Self-filtering matches our own sent relay-message ids (primary) and
 *    our own personaId on delivered echoes (the relay now attributes owned
 *    webhook echoes as `kind:"persona"`, including through the send race).
 * 2. Surface classification is container-first: traffic in the control
 *    thread is control. The `!floor …` / `⟨floor⟩ …` prefix rule is kept
 *    as a HUMAN-TOLERANCE rule, not a relay workaround — a person typing
 *    `!floor join` in the room channel still reaches the arbiter. Traffic
 *    in unrelated threads under the room channel is not the room's.
 * 3. The `webhook:` name-keyed identity survives only as a last resort for
 *    authors the relay itself cannot attribute (foreign webhooks; personas
 *    with ambiguous displayNames, which the relay declines to guess). It
 *    keeps the collision-refusing fingerprint: the same derived id arriving
 *    with a different underlying shape is dropped and reported, never
 *    silently merged.
 *
 * Sends are hardened: one retry, then log-and-drop — a single RPC timeout
 * must never become an unhandled rejection that kills the arbiter (that is
 * exactly how the first live run died).
 */

import { readFileSync } from 'node:fs';
import { PortalClient } from '@animalabs/portal-client';
import type { InboundMessage, RoomTransport } from './transport.js';

export interface PortalTransportOptions {
  url: string;
  /** JSON file: { "personaId": "...", "token": "..." } */
  credsFile: string;
  /** Persona display name — used for webhook-echo self-filtering. */
  personaName: string;
  roomChannelId: string;
  /** Thread for outgoing control traffic (readability); inbound
   *  classification is syntactic, not thread-based. */
  controlThreadId?: string;
  /** Receives anomaly records (identity refusals, send drops) so the run
   *  can ledger them — a drop that only reaches a console is not a receipt. */
  onAnomaly?: (entry: Record<string, unknown>) => void;
}

const CONTROL_PREFIXES = ['!floor', '⟨floor⟩'];

export class PortalTransport implements RoomTransport {
  readonly locator: string;
  readonly provenance: string;
  private client: PortalClient;
  private handlers: Array<(m: InboundMessage) => void> = [];
  private sentIds = new Set<string>();
  /** Our own persona id — id-shaped self-filtering for delivered echoes. */
  private readonly personaId: string;
  /** Derived participantId → first-seen raw fingerprint, for the residual
   *  `webhook:` last-resort identities only (see header note 3). */
  private fingerprints = new Map<string, string>();

  constructor(private opts: PortalTransportOptions) {
    const creds = JSON.parse(readFileSync(opts.credsFile, 'utf8')) as {
      personaId: string;
      token: string;
    };
    this.personaId = creds.personaId;
    this.locator = `portal://${opts.roomChannelId}`;
    this.provenance = `portal-relay:${new URL(opts.url).host}`;
    this.client = new PortalClient({
      url: opts.url,
      token: creds.token,
      personaId: creds.personaId,
      subscriptions: [opts.roomChannelId],
    });
    this.client.on('message', ({ message: m }) => {
      const msg = this.toInbound(m);
      if (!msg) return;
      this.handlers.forEach((h) => {
        try {
          h(msg);
        } catch (err) {
          console.error(`[portal-transport ${this.opts.personaName}] handler error:`, err);
        }
      });
    });
  }

  /** Classify one relay delivery into the trial's inbound shape, or null for
   *  traffic that is not the room's (own echoes, unrelated threads, refused
   *  identities). Extracted so the classification is testable without a
   *  relay connection. */
  toInbound(m: {
    id: string;
    nativeId: string;
    channelId: string;
    threadId?: string;
    content?: string;
    createdAt: string;
    author: unknown;
  }): InboundMessage | null {
    if (m.channelId !== this.opts.roomChannelId) return null;
    // A thread under the room channel that is not the control thread is some
    // other conversation, not the room's traffic.
    if (m.threadId && m.threadId !== this.opts.controlThreadId) return null;
    if (this.sentIds.has(m.id)) return null; // own send, echoed back
    const author = m.author as {
      kind: string;
      personaId?: string;
      userId?: string;
      displayName?: string;
      username?: string;
      bot?: boolean;
    };
    // Id-shaped self-filter: the relay attributes owned webhook echoes as
    // kind:"persona" even when the echo beats the send RPC (portal#19), so
    // our own personaId is sufficient — no name-shape matching.
    if (author.kind === 'persona' && author.personaId === this.personaId) return null;
    // A persona author without a personaId is a shape the relay should never
    // emit; treat it as unattributed rather than minting "persona:undefined".
    const authorId =
      author.kind === 'persona' && author.personaId
        ? `persona:${author.personaId}`
        : author.bot
          ? `webhook:${author.username ?? author.displayName}`
          : `user:${author.userId}`;
    const raw = {
      relayMessageId: m.id,
      kind: author.kind,
      userId: author.userId,
      personaId: author.personaId,
      username: author.username,
      displayName: author.displayName,
      bot: author.bot,
      threadId: m.threadId,
    };
    // Collision refusal for the residual name-keyed identities: same derived
    // id, different underlying shape → dropped and reported, never merged.
    if (authorId.startsWith('webhook:')) {
      const fp = `${author.kind}|${author.bot ? 'bot' : 'user'}`;
      const seen = this.fingerprints.get(authorId);
      if (seen === undefined) {
        this.fingerprints.set(authorId, fp);
      } else if (seen !== fp) {
        this.opts.onAnomaly?.({ kind: 'identity-refusal', at: Date.now(), authorId, expected: seen, got: fp, raw });
        return null;
      }
    }
    const text = m.content ?? '';
    // Container-first classification; prefixes kept as human tolerance so a
    // person typing `!floor join` in the room channel still reaches the
    // arbiter (the invitation says "in the control thread" — people won't).
    const surface =
      m.threadId === this.opts.controlThreadId && this.opts.controlThreadId
        ? ('control' as const)
        : CONTROL_PREFIXES.some((p) => text.startsWith(p))
          ? ('control' as const)
          : ('room' as const);
    return {
      authorId,
      authorName: author.displayName ?? author.username ?? authorId,
      surface,
      messageId: m.nativeId,
      text,
      at: Date.parse(m.createdAt),
      raw,
    };
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  onMessage(handler: (m: InboundMessage) => void): void {
    this.handlers.push(handler);
  }

  async sendRoom(text: string): Promise<string> {
    return this.safeSend({ channelId: this.opts.roomChannelId, content: text });
  }

  async sendControl(text: string, mention?: string): Promise<string> {
    const mentionPersonaIds =
      mention?.startsWith('persona:') ? [mention.slice('persona:'.length)] : undefined;
    return this.safeSend({
      channelId: this.opts.roomChannelId,
      ...(this.opts.controlThreadId ? { threadId: this.opts.controlThreadId } : {}),
      content: text,
      mentionPersonaIds,
    });
  }

  /** One retry, then log-and-drop. Never throws into a fire-and-forget. */
  private async safeSend(params: Parameters<PortalClient['sendMessage']>[0]): Promise<string> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await this.client.sendMessage(params);
        this.remember(r.messageId);
        return r.messageId;
      } catch (err) {
        if (attempt === 2) {
          console.error(`[portal-transport ${this.opts.personaName}] send failed twice, dropping:`, (err as Error).message);
          this.opts.onAnomaly?.({
            kind: 'send-drop',
            at: Date.now(),
            persona: this.opts.personaName,
            error: (err as Error).message,
            contentPreview: String((params as { content?: string }).content ?? '').slice(0, 80),
          });
          return '';
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return '';
  }

  private remember(id: string): void {
    this.sentIds.add(id);
    if (this.sentIds.size > 500) {
      const oldest = this.sentIds.values().next().value;
      if (oldest) this.sentIds.delete(oldest);
    }
  }

  async close(): Promise<void> {
    this.client.close?.();
  }
}

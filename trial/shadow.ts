/**
 * Shadow mode, stage 0 of the rev 8 testing ladder: observe a live
 * channel, record turn-taking RHYTHM, send nothing, keep no content.
 *
 * With no participants bidding, there is nothing to arbitrate — shadow
 * mode's product is the calibration data the lab cannot produce: real
 * inter-message gaps, speaker transitions, and quiet-epoch shapes, from
 * which lease lengths and accept-TTLs stop being guesses. (A later pass
 * may synthesize hypothetical bids from speech and diff fairness order
 * against actual order; v1 stays purely observational.)
 *
 * §9 by construction: the record shape has no text field — the recorder
 * cannot leak what it never accepts.
 */
import type { InboundMessage } from './transport.js';

export interface SpeechRhythmRecord {
  kind: 'speech-rhythm';
  at: number;
  authorId: string;
  messageId: string;
  bytes: number;
  surface: 'room' | 'control';
  inThread: boolean;
  /** ms since the previous observed message on this surface; null = first. */
  gapMs: number | null;
  /** Did the speaker change from the previous message on this surface? */
  transition: boolean;
}

export class ShadowRecorder {
  private last = new Map<string, { at: number; authorId: string }>();

  constructor(private ledger: (entry: SpeechRhythmRecord) => void) {}

  observe(m: InboundMessage): void {
    const prev = this.last.get(m.surface);
    this.ledger({
      kind: 'speech-rhythm',
      at: m.at,
      authorId: m.authorId,
      messageId: m.messageId,
      bytes: Buffer.byteLength(m.text, 'utf8'),
      surface: m.surface,
      inThread: Boolean((m.raw as { threadId?: string } | undefined)?.threadId),
      gapMs: prev ? m.at - prev.at : null,
      transition: prev ? prev.authorId !== m.authorId : true,
    });
    this.last.set(m.surface, { at: m.at, authorId: m.authorId });
  }
}

/**
 * Reference shadow-bid adapter — the consenting participant's half of
 * stage 0b (see trial/ADAPTER-SPEC.md for the contract this implements).
 *
 * The adapter is deliberately WRITE-ONLY: it emits ops to the control
 * surface and speech to the room, and never reads either band — there is
 * nothing to read; the shadow book delivers nothing. Everything the
 * instrument needs is carried by three gestures:
 *
 *   begin()   — compose-start. Joins once, then bids. THIS is the
 *               honest moment: intent observed before speech. Calling it
 *               at send-time instead collapses book residency to zero and
 *               reproduces the replayer's degenerate null model (M0) —
 *               the exact fiction real shadow bids exist to replace.
 *   speak()   — the room message. The instrument observes it as speech;
 *               no op accompanies it (speech IS the acceptance).
 *   abandon() — composed-then-decided-not-to. A real bid/cancel analog:
 *               the withdrawn intention the backscroll can never show.
 *
 * begin() during your own burst window is safe (the instrument treats a
 * holder's re-bid as continuation intent); begin() twice is safe (the
 * book replaces). The adapter therefore needs NO state about the book —
 * only whether it has joined and whether an intention is outstanding.
 */

import type { RoomTransport } from './transport.js';

export interface ShadowBidAdapterOptions {
  /** Declared readiness for bids (default 'prepared': a harness agent
   *  that reached compose-start will produce its message shortly). */
  readiness?: 'intent' | 'prepared';
}

export class ShadowBidAdapter {
  private joined = false;
  private outstanding = false;

  constructor(
    private transport: Pick<RoomTransport, 'sendRoom' | 'sendControl'>,
    private opts: ShadowBidAdapterOptions = {},
  ) {}

  /** Compose-start: the intention exists, the message doesn't yet. */
  async begin(subjectRef?: string): Promise<void> {
    if (!this.joined) {
      await this.transport.sendControl('!floor join');
      this.joined = true;
    }
    const readiness = this.opts.readiness ?? 'prepared';
    await this.transport.sendControl(
      `!floor bid readiness=${readiness}${subjectRef ? ` subject=${subjectRef}` : ''}`,
    );
    this.outstanding = true;
  }

  /** The speech the intention was for. Returns the transport's message id. */
  async speak(text: string): Promise<string> {
    this.outstanding = false; // discharged by the speech itself, book-side
    return this.transport.sendRoom(text);
  }

  /** Composed, then decided not to send: withdraw the intention. */
  async abandon(): Promise<void> {
    if (!this.outstanding) return;
    this.outstanding = false;
    await this.transport.sendControl('!floor cancel');
  }
}

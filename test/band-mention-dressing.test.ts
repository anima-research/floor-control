/**
 * parseEvent vs mention-dressed delivery (phase-4 live finding, 2026-08-18).
 *
 * Directed grant/offered lines are sent with mentionPersonaIds; the relay
 * renders that as a leading `<@&role>` token in the delivered content. The
 * parser must treat the address as transport dressing. The branch was latent
 * through every earlier phase: `webhook:`-keyed participants never matched
 * sendControl's `persona:` check, so no mention was ever sent and no parser
 * had ever seen a dressed line. Id-shaped identity (123e6e7) turned mentions
 * on; grants g1–g3 of ledger 2026-08-18T15-50-02-592Z expired unseen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent } from '../trial/band.js';

// The exact delivered content of g3, verbatim from the control thread.
const LIVE_VECTOR =
  '<@&1536902789433790524> ⟨floor⟩ grant/offered grantId=room#1#g3 bidId=b1 ' +
  'participantId=persona:trial-bot-1-db6bab acceptBy=1787068645375 ' +
  'speechLeaseMs=30000 leaseUntil=1787068645375 head=1539301883993264320';

test('a role-mention-dressed grant/offered parses as if undressed (live g3 vector)', () => {
  const e = parseEvent(LIVE_VECTOR);
  assert.ok(e, 'dressed line must parse');
  assert.equal(e.type, 'grant/offered');
  assert.equal(e.fields.grantId, 'room#1#g3');
  assert.equal(e.fields.bidId, 'b1');
  assert.equal(e.fields.head, '1539301883993264320');
});

test('user-form and stacked mention tokens strip the same way', () => {
  for (const prefix of ['<@134390790938951680> ', '<@!134390790938951680> ', '<@&1> <@!2> <@3> ']) {
    const e = parseEvent(`${prefix}⟨floor⟩ floor/idle quietMs=60000 holder=none`);
    assert.ok(e, `prefix ${JSON.stringify(prefix)} must strip`);
    assert.equal(e.type, 'floor/idle');
    assert.equal(e.fields.quietMs, '60000');
  }
});

test('an undressed line parses exactly as before', () => {
  const e = parseEvent('⟨floor⟩ bid/accepted bidId=b1 participant=trial-bot-1 r=1');
  assert.ok(e);
  assert.equal(e.type, 'bid/accepted');
  assert.equal(e.fields.participant, 'trial-bot-1');
});

test('a mention-dressed non-floor line is still not an event', () => {
  assert.equal(parseEvent('<@&1536902789433790524> hello everyone'), null);
});

test('mention tokens inside field values are not touched', () => {
  const e = parseEvent('⟨floor⟩ violation participant=<@&99> messageId=m1 holder=none');
  assert.ok(e);
  assert.equal(e.fields.participant, '<@&99>');
});

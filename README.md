# floor-control

Medium-agnostic floor control for shared rooms: who may speak right now.

A neutral floor state machine (request/withdraw, visible queue and state, grant/lease,
renew, release, revoke, expiry, receipts, manual-override surface) with pluggable
arbitration **strategies** deciding who receives the next grant — automated
conversational arbitration for fluid voice/text/eidoverse rooms, chaired mode for
formal meetings, and future policies. Transports (Portal/Discord, text surfaces,
eidoverse) are clients and enforcers; they never select.

Founding design: **FLOOR-RFC-001** (lands here, with the Governance Session 1
minutes committed beside it as the chaired profile's normative precedent).

Repo created 2026-08-06 at antra's request; RFC and reference service to follow
from the working draft in Ra's tree.

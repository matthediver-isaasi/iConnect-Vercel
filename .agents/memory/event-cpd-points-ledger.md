---
name: Event CPD points ledger
description: Durable integrity rules for event-driven CPD point awards, retries, and reversals.
---

CPD points use a signed, append-only ledger. Never make a mutable total authoritative, and never edit or delete an award to correct it; append a linked reversal or future adjustment instead.

**Why:** Earned points must remain auditable against the event rule and attendance evidence that existed at award time, even after configuration, bookings, or provider outcomes change.

**How to apply:** Snapshot the effective rule, ticket, trigger, and evidence on every award. A ticket rule replaces the entire event-wide rule before trigger evaluation. Retry unresolved evidence through an outbox while enforcing one positive award per event/booking occurrence. Bind evidence reversals to the exact snapshotted attendance target so an unrelated session cannot remove valid points.

Manual corrections are also append-only: link each adjustment to the original positive award, require a reason and actor, and use a tenant-scoped idempotency key so exact retries return the original correction while conflicting reuse fails.

**Why:** Admin retries must not double-adjust a balance, and an adjustment without its source award cannot establish tenant ownership or preserve a useful audit chain.

**How to apply:** Accept signed non-zero adjustments only through the guarded correction RPC. Reversals remain unique per award; never make a manual adjustment by editing, deleting, or replacing an existing ledger row.

Historical import overlap review requires a quiet native-award window, even though imported source identity and ownership are transactionally enforced.

**Why:** Native awards have no shared legacy activity identifier. Read-only overlap preflight cannot exclude a native award arriving between its final read and an import transaction; automatic deduplication would discard potentially legitimate credits.

**How to apply:** Explicitly review candidate overlaps and coordinate native-award processing during approved historical imports. Never infer import permission from the source Approved or Locked flags, or substitute legacy IDs/name matching for confirmed UUID ownership.
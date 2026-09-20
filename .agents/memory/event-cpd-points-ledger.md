---
name: Event CPD points ledger
description: Durable integrity rules for event-driven CPD point awards, retries, and reversals.
---

CPD points use a signed, append-only ledger. Never make a mutable total authoritative, and never edit or delete an award to correct it; append a linked reversal or future adjustment instead.

**Why:** Earned points must remain auditable against the event rule and attendance evidence that existed at award time, even after configuration, bookings, or provider outcomes change.

**How to apply:** Snapshot the effective rule, ticket, trigger, and evidence on every award. A ticket rule replaces the entire event-wide rule before trigger evaluation. Retry unresolved evidence through an outbox while enforcing one positive award per event/booking occurrence. Bind evidence reversals to the exact snapshotted attendance target so an unrelated session cannot remove valid points.

Historical import overlap review requires a quiet native-award window, even though imported source identity and ownership are transactionally enforced.

**Why:** Native awards have no shared legacy activity identifier. Read-only overlap preflight cannot exclude a native award arriving between its final read and an import transaction; automatic deduplication would discard potentially legitimate credits.

**How to apply:** Explicitly review candidate overlaps and coordinate native-award processing during approved historical imports. Never infer import permission from the source Approved or Locked flags, or substitute legacy IDs/name matching for confirmed UUID ownership.
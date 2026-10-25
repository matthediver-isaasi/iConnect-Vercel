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

Manual attendee certificates and member CPD points are distinct evidence boundaries. A guest with no attendee-matched member may display the effective, qualifying ticket/event rule's points on a manually generated certificate without creating a member or ledger award. An attendee-matched member's certificate points must instead come from that attendee's booking-scoped ledger entries; a missing member award must not be papered over with rule-derived guest points or the purchaser's ledger.

**Why:** A group booking's `member_id` can identify the purchaser, while the actual attendee is a guest. Requiring a member ledger for all certificates blanks legitimate guest certificates, but treating a certificate as a ledger award would overstate earned member credit.

**How to apply:** Resolve attendee identity by tenant-scoped attendee email, never by purchaser alone. For unmatched attendees, use the active ticket override (which replaces the event rule) or event rule only when booking status and its registration/attendance trigger qualify; snapshot rule and attendance evidence into the certificate fingerprint/delivery provenance. Preview/download/test email never award points. The explicit admin override below supersedes the former blanket no-award-on-send rule for matched members.

Manual admin certificate sending may explicitly award an individual's effective rule points before the event or without attendance, with an actor and reason audit; it must not alter the event's rules or attendance records.

**Why:** The owner approved this for incorrect registrations and individual advance issuance without changing the overall event award setup.

**How to apply:** Show prospective points as not yet awarded, require explicit override consent, serialize against automatic awards, and never duplicate an existing award on resend. If email fails after the award, preserve the ledger entry and report the delivery failure separately.

Historical certificate access must not create event attendance or reinterpret imported points as CPD hours. The user requires the original award's title and points, not its description, a recalculated balance, or designer samples.

**Why:** Imported awards establish only the historical facts they actually contain; a certificate is not permission to invent missing event or attendance evidence.

**How to apply:** Keep historical certificate work separate from importing/editing records, emailing, and permanent issuance archives unless explicitly requested. Leave unknown fields blank or fail required fields, and never automatically choose a historic template for an existing tenant.

Standalone manual CPD awards belong in the normal member CPD history and balance
with downloadable certificates, but must not fabricate event registration or
attendance. Preserve the issued certificate independently of later template edits.

**Why:** The user requested individual awards with a chosen certificate, points,
event name/date and optional custom email, accessible like automatically generated
awards. A manual administrative award is not evidence of event attendance.

**How to apply:** Keep preview side-effect-free and email delivery separate from
the immutable award. Email failures and retries must never duplicate points;
ambiguous provider outcomes require reconciliation rather than automatic resending.
---
name: Event CPD badge awards
description: Durable correctness rules for event-triggered badge grants across registration and attendance evidence.
---

Ticket-specific badge rules override the whole event-wide configuration, not only the matching trigger. If a ticket is configured for attendance, it must not inherit an event-wide registration award.

**Why:** Filtering rules by trigger before resolving ticket precedence can grant both the inherited event badge and the ticket badge.

**How to apply:** Load all active rules for the event, resolve ticket scope first, then compare the winning rule's trigger.

Resolve the member from the attendee identity, not the booking's generic member reference. Badge creation and its idempotency/audit attempt must commit in one database transaction.

**Why:** Group and colleague bookings may store the purchaser as `member_id`; split writes can leave an award without its idempotency record and allow a retry under changed configuration.

**How to apply:** Match the tenant-scoped attendee email exactly, fail closed on ambiguity, and use a restricted transactional RPC keyed by the delivery idempotency key.

Attendance transitions enqueue badge work independently of workflow publication. QR eligibility is based on the latest check-in generation: a reversal only invalidates a check-in at or before that reversal, and later re-check-in can qualify without deleting prior history.

**Why:** Coupling badge processing to workflow delivery lets one feature block the other, while a record-only QR key suppresses legitimate re-check-ins after reversal.

**How to apply:** Use a dedicated retryable outbox, include booking/target/revision or check-in timestamp in keys, reload current evidence before granting, and never auto-revoke historical awards.
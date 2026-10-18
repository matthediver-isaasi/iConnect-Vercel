---
name: Member inbox eligibility and unread authority
description: Preserve historical delivery classification, count only eligible unread messages, and avoid auto-read query invalidation loops.
---

# Eligibility must govern counts as well as reads

Never subtract unqualified read/archive state counts from delivered totals.
Retained states can belong to excluded test messages, unsent rows or missing
recipients. Stateless eligible deliveries still count as unread.

**Why:** hiding historical campaign tests while retaining their state exposes
the false assumption that every state row represents an eligible message.

**How to apply:** count unread and choose latest previews from the same eligible,
tenant/member-scoped message relation used by detail and mutation authorization.
Keep aggregation database-side rather than enumerating all deliveries on every
badge poll.

# Campaign test mode is historical, not a mutable display preference

Later campaign-setting edits must not reclassify already recorded test/live
submissions. Explicit test-destination sends are real emails to that chosen
destination and must not alter the audience recipient's delivery history.

**Why:** the campaign flag is editable after sending; current flags cannot prove
historical Mailgun mode. Old flag edits cannot be reconstructed from names or
subjects. Unknown future submission evidence must not expose a message.

**How to apply:** preserve submission evidence across retries and ambiguous
outcomes. Quiesce old sender workers during schema/code rollout; a one-time
backfill cannot safely classify later old-worker sends.

# Opening messages must not invalidate their own body query

Use exact-key invalidation for the list and badge after auto-read.

**Why:** a prefix invalidation also refetches the body that auto-marks read,
creating a repeated fetch/invalidation loop.

**How to apply:** when adding an auto-read surface, refresh list and count without
invalidating the currently displayed message body.

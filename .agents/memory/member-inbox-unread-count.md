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

The GFI cleanup request is specifically to remove these three test campaigns
from members' inboxes: “Fast Track - Audience Preparation Test - 13 October
2026”, “Fast Track - Bulk Speed Test - 12 October 2026”, and “Fast Track –
Speed Test – 12 October 2026”.

**Why:** The user explicitly narrowed the request after the broader rollout and
history investigation became disproportionate to the requested inbox cleanup.

**How to apply:** Treat member-inbox visibility as the requested outcome.
Verify the deployed reader, not just database classification. Keep unrelated
history reconciliation and sender-resumption decisions separate from hiding
these messages; do not delete delivery evidence to compensate for stale readers.

Later campaign-setting edits must not reclassify already recorded test/live
submissions. Explicit test-destination sends are real emails to that chosen
destination and must not alter the audience recipient's delivery history.

**Why:** the campaign flag is editable after sending; current flags cannot prove
historical Mailgun mode. Old flag edits cannot be reconstructed from names or
subjects. Unknown future submission evidence must not expose a message.

**How to apply:** preserve submission evidence across retries and ambiguous
outcomes. Quiesce old sender workers during schema/code rollout; a one-time
backfill cannot safely classify later old-worker sends.

# Provenance backfills can invoke unrelated delivery guards

Capture recoverable before-images as well as aggregate checksums before a
recipient provenance backfill; inspect all UPDATE triggers, not only triggers
on the new field.

**Why:** A production backfill committed but its recipient checksum excluding the
new field changed. An existing all-UPDATE delivery-status guard can normalize
historical status/error/timestamp fields; checksums alone cannot identify the
exact changed rows or distinguish trigger effects from concurrent provider events.

**How to apply:** Do not equate retained row counts with unchanged history. Report
post-commit verification failures as committed-with-exception, never as rolled
back; do not guess restoration values or resume senders without reconciliation.

# Opening messages must not invalidate their own body query

Use exact-key invalidation for the list and badge after auto-read.

**Why:** a prefix invalidation also refetches the body that auto-marks read,
creating a repeated fetch/invalidation loop.

**How to apply:** when adding an auto-read surface, refresh list and count without
invalidating the currently displayed message body.

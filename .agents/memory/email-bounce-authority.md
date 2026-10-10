---
name: Email bounce policy
description: Address-scoped campaign suppression, chronological delivery evidence and audited resolution.
---
Hard bounces pause campaigns for the affected email address within its tenant, not the member identity. Keep consent separate. Corrected member addresses must not inherit the old address's suppression.

**Why:** The user requested a cross-campaign Communications Management report and a warning next to the member's email, with safe exclusion from subsequent campaigns.

**How to apply:** Check queued sends too. Require an audited reason and a successful read-only provider suppression check before re-enabling; do not send tests, remove provider suppression or resubscribe as a side effect.

Temporary failures must not override later successful delivery. Require the matching provider message as well as tenant, campaign and recipient; legacy email-only matching is insufficient authority.

**Why:** Historical events can be imported out of order. A temporary timeout arrived in storage after successful delivery and incorrectly won the old status-priority rule.

**How to apply:** Compare provider event times, retain original history, distinguish retry exhaustion from an invalid address, and treat clicks/opens as tracking evidence rather than proof of delivery or human reading.

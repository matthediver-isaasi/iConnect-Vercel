---
name: Campaign outcome evidence
description: Why skipped recipients and uncertain processing must not imply cancelled mail or safe retries.
---

Suppression before submission means the recipient was skipped, not that mail was
recalled. A post-send unsubscribe or bounce is not an unsent exclusion.
Uncertain processing must remain separate from queued work and must never be
offered as a safe resend.

**Why:** The owner reported a campaign's sent/original-total display obscuring
suppression and unresolved provider acceptance. “Cancelled” was misleading for
historical hard-bounce suppression.

**How to apply:** Use recorded delivery evidence, not the original audience
denominator or current address suppression, to explain historical outcomes.
If no individual claim time is recorded, label warnings as campaign-age based
rather than asserting an individual processing duration. A completion timestamp
before creation is evidence of an anomaly, not proof of its historical writer;
reset new lifecycle state atomically without silently repairing prior sends.

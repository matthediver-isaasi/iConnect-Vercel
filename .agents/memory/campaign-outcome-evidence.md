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

Fully accepted batches may still look unfinished locally, including recipients
whose click status arrived before the send-result write. Reconcile using exact
campaign, recipient, live/test provenance and provider message identity; never
retry merely because a local message ID is missing.

**Why:** A final batch had complete Mailgun acceptance but no local send evidence.
The apparent hour-long send delay was a reporting/reconciliation delay.

**How to apply:** Require complete audience evidence before recovering a transport
completion timestamp. Preserve original records and the later repair time in an
audit. Do not remove real gaps from elapsed times or equate acceptance with delivery.

Legacy processing rows without submission-stage evidence must remain uncertain
even when a Mailgun search returns no acceptance. Display needs-attention instead
of pretending the campaign completed; preserve the interruption in its timings.

**Why:** The owner approved safe recovery and truthful campaign statuses after a
newsletter stopped with unresolved recipients. Negative provider search results
do not prove that a timed-out request never reached the provider.

**How to apply:** Automatically retry only fenced, demonstrably unsubmitted
claims. Reconcile uncertain submissions from exact positive provider evidence;
do not extend this authority to blind resends or hide the historical gap.

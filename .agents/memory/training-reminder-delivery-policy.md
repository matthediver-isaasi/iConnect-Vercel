---
name: Training reminder delivery policy
description: Per-entry scheduling scope and fail-closed delivery outcome policy.
---
Training relative reminders are per dated agenda entry, not per calendar day. Date ranges anchor only to their start. Day offsets remain elapsed 24-hour periods.

**Why:** The owner explicitly required preserving entry scope and existing offset semantics; complex-event calendar-day deduplication is a different policy.

**How to apply:** Keep new bookings, explicit scheduling and previews on the same target calculation. Saving templates is never permission to queue or resend. Unknown provider outcomes must remain non-retryable; investigate delivery evidence before authorizing a replacement.

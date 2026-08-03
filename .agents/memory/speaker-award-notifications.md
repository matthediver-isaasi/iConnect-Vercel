---
name: Cron email delivery model (lease vs delivered)
description: Pattern for reliable one-off notification emails sent by cron sweeps against per-row state.
---

For cron-driven notification emails keyed to a database row, track each recipient with a PAIR of timestamps: an expiring send lease (claimed before sending; stealable after a TTL via compare-and-set on the exact stale value) and a delivered stamp written only after a confirmed send (compare-and-set on IS NULL). An overall done marker is stamped only after re-reading the row and confirming every required recipient is delivered.

**Why:** a single claim-before-send column conflates "someone is trying" with "it was delivered". Under crashes or concurrent runs that either loses owed emails permanently (claim kept after failure once the parent leaves its work queue) or double-sends (claim released while another worker treats it as delivered).

**How to apply:**
- Retry sweeps must select unnotified rows independently of any parent-level "processing complete" stamp, or failures stop retrying once the parent is done.
- Never clear a lease unconditionally — CAS on your own lease value only, or a stolen lease's new holder gets clobbered and the claim reopens to more workers.
- Re-check the delivered stamp after acquiring a lease, immediately before sending.
- Accept at-least-once per recipient: a crash between send and stamp yields one duplicate after the lease TTL, never a lost email.

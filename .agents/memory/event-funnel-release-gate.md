---
name: Event funnel worker release gate
description: Every production publish pauses all funnel background workers until the new commit is recorded as verified; and issued-invoice line matching quirk.
---
Rule: funnel workers (recovery, reversals) run only when the production commit equals `event_funnel_rollout.verified_release`. Each publish silently disables invoices, confirmations, reminders and refunds for funnel orders until that is updated.

**Why:** discovered 2026-11-28 after a publish: queues stopped at the deploy time with no errors (admission just returns enabled:false).

**How to apply:** after every publish that touches the app, confirm the live commit (the public JS bundle embeds the commit SHA; the Vercel token is invalid) and, with owner approval, update verified_release and append to verification_evidence.releaseUpdates. Owner approved doing this on 2026-11-28.

Related quirk: Xero invoice creation appends "\nBooking reference: <allocation key>" to line 0. Any comparison of issued lines against the frozen snapshot must allow exactly that suffix, or evidence recording fails forever as an unknown (retrying) error.

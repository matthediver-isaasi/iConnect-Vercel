---
name: Membership-paid workflow firing paths
description: Every path that settles a membership invoice as paid must fire the shared paid-workflow helper and mark the row paid at creation.
---

The admin-facing "membership paid" trigger is a `field_change` on `payment_status` unpaid→paid for the member/organization entity — there is no dedicated trigger type.

**Rule:** any path that creates or settles a membership history row as paid must (a) set `payment_status='paid'` + `paid_at` on the row so the reconciliation cron (which polls unpaid/partial rows with an invoice id) never re-processes it, and (b) fire `fireWorkflowForPaidRow` from `membershipPaymentReconciliation.js` — never hand-roll the before/after payload, it carries invoice convenience fields workflows depend on.

**Why:** the card-confirm endpoint originally inserted rows with the default `payment_status='unpaid'` while marking the accounting invoice paid, so paid rows never passed through the cron transition and the workflow silently never fired for card payments.

**How to apply:** fire on payment-success, not accounting-sync success (Xero/QBO failure must not suppress the workflow); wrap in try/catch so it can't break the payment response; gate on "this request inserted the row" (not on idempotent/duplicate-constraint branches) to fire exactly once. The one-off historic backfill rule still holds: backfills must never fire workflows.

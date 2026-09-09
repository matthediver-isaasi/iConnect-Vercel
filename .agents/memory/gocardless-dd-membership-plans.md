---
name: GoCardless monthly DD membership plans
description: Design rules for the monthly Direct Debit membership checkout, agreement snapshot, and portal/admin plan surfaces.
---

- The DD offer is derived from the membership SIMULATION result, never raw config: flat pricing reads the config monthly amount, banded pricing reads the matched band's amount and must NOT fall back to the config amount.
- **Why:** a banded tier with a config-level amount would silently charge the wrong price for a member whose band has no DD amount — absence of a band amount means "DD not offered for this band".
- Terms are snapshotted onto the billing agreement at consent time (`buildAgreementSnapshot`); webhooks and activation read ONLY the snapshot, so later tier edits never change an in-flight plan.
- New monthly-membership GBP/Bacs Billing Requests are mandate-only; after authorisation, one idempotent finite subscription represents all N collections. Legacy in-flight snapshots with `billing_request_payment` retain first-payment plus N−1 behavior.
- Do not send `subscription_request` or `instalment_schedule_request` for GBP/Bacs Billing Requests. GoCardless supports them only for ACH/PAD, and its sandbox rejects Bacs with `request_type_not_supported_by_scheme`.
- **Why:** the native GoCardless Bacs consent cannot display a finite subscription schedule; implementing the nominal recurring payload breaks every new UK Direct Debit setup before consent.
- **How to apply:** show amount, currency, count, and collection timing in the app before opening GoCardless, then use mandate-only consent and create the finite subscription from the immutable snapshot unless GoCardless adds Bacs support.
- A mandate-only subscription start must be on/after both today and GoCardless's freshly fetched `next_possible_charge_date`; always refresh/persist it before creation, even when the mirror has a date.
- **Why:** anniversary-day schedules can otherwise select a date before Bacs permits collection, causing GoCardless to reject the complete finite plan after consent.
- Initial-payment finalization needs its own durable completion marker outside the immutable DD snapshot. Reconciliation may resume unfinished activation/accounting/completion, but must never let the old first payment clear arrears or retry state from a later collection.
- **Why:** provider payment, mandate, and fulfillment webhooks can arrive in any order or fail between local side effects; generic payment replay can otherwise either strand a paid membership or falsely recover later debt.
- Activation is rule-driven (`mandate` / `first_payment` / `manual`) via `decideMembershipActivation`; `mandate` also accepts a late first-payment trigger so out-of-order webhooks still activate.
- Renewal reuses an active mandate server-side in the start endpoint (no hosted flow, `reusedMandate: true`); renewal AUTOMATION (acting on `dd_auto_renew`) is intentionally not built.
- Portal/admin surfaces are fed solely by `GET /api/membership/payment-plan` (member view + `?admin=1` RBAC-gated list); bank details are never exposed to the client.
- **How to apply:** any new DD surface or lifecycle path must read the agreement snapshot, not tier config, and go through the pure helpers in `api/_lib/gocardlessDirectDebit.js`. Keep first-payment reconciliation isolated from ordinary recurring-payment recovery.
- Form-originated recurring DD consent starts applicant-scoped and unbound; after the form pipeline resolves the member, one transaction must bind the agreement and create its pending membership-history row before any subscription is created.
- **Why:** Billing Request and mandate webhooks may arrive before the applicant exists as a member. Creating a subscription first can collect money for an agreement that no membership row owns, while retries can duplicate or cross-link the membership year.
- **How to apply:** distinguish recurring form DD from generic one-off form GoCardless with its own provider/state discriminator; browser confirm, Billing Request webhooks, mandate webhooks, and reconciliation must all finalize and reload the agreement before subscription creation.

---
name: GoCardless monthly DD membership plans
description: Design rules for the monthly Direct Debit membership checkout, agreement snapshot, and portal/admin plan surfaces.
---

- The DD offer is derived from the membership SIMULATION result, never raw config: flat pricing reads the config monthly amount, banded pricing reads the matched band's amount and must NOT fall back to the config amount.
- **Why:** a banded tier with a config-level amount would silently charge the wrong price for a member whose band has no DD amount — absence of a band amount means "DD not offered for this band".
- Terms are snapshotted onto the billing agreement at consent time (`buildAgreementSnapshot`); webhooks and activation read ONLY the snapshot, so later tier edits never change an in-flight plan.
- Activation is rule-driven (`mandate` / `first_payment` / `manual`) via `decideMembershipActivation`; `mandate` also accepts a late first-payment trigger so out-of-order webhooks still activate.
- Renewal reuses an active mandate server-side in the start endpoint (no hosted flow, `reusedMandate: true`); renewal AUTOMATION (acting on `dd_auto_renew`) is intentionally not built.
- Portal/admin surfaces are fed solely by `GET /api/membership/payment-plan` (member view + `?admin=1` RBAC-gated list); bank details are never exposed to the client.
- **How to apply:** any new DD surface or lifecycle path must read the agreement snapshot, not tier config, and go through the pure helpers in `api/_lib/gocardlessDirectDebit.js` (unit-tested in the sibling `.test.mjs`).

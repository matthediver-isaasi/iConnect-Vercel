---
name: Invoice order submission alerts
description: Accepted invoice orders qualify before settlement; historical BNMS alerts must not be recovered.
---

Submission alerts for accepted invoice orders must not depend on an invoice
being paid. Order acceptance and settlement are distinct facts.

**Why:** Valid pay-by-invoice submissions remain unpaid, so a paid-only alert
gate suppressed their notifications.

**How to apply:** Use committed order/accounting authority and retain unpaid
status. Keep queue insertion transactional with acceptance and stock finalization;
do not infer acceptance from a client-selected payment method alone.

Do not recover the historical missed alerts for BNMS form
`56f11cfb-2ffa-4665-8294-a92943ca6700` under the current approval.

**Why:** On 2026-11-19 the owner explicitly said the tenant had already checked
the submissions and did not need the missed alerts recovered.

**How to apply:** Keep this repair forward-only. Deployment and later edits to
old submissions must not create historical notifications. Any future deliberate
resend needs fresh approval.

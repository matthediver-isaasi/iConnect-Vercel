# BNMS membership invoice recovery — 26 October 2026

## Result

Recovered personal history `f367ee9f-f5e1-4f1f-ad98-57db32191a63` for
member `53095180-56fe-42cd-a8c0-88f0c773c530`, tenant
`ff2df806-b321-4254-b651-3af11fccf1db` (BNMS), on verified destination
`lvmzliemqnieeoruhkik`. The associated organisation was independently verified
as Royal Bolton Hospital in the same tenant; it had no organisation membership
history. The older personal history was not changed.

- Term: 17 October 2026–16 October 2027.
- Stripe PaymentIntent: `pi_3UQrJm0UfSpC8b2b1OA6rkj2`.
- Saved quote: `7416ed82-a818-4427-bb9c-e5471b6c8cc1`.
- Stripe independently confirmed succeeded, amount received £156 GBP.
- Xero invoice created: **INV-9378**, `f283c5b9-4579-4441-96cc-26c92405de2d`.
- Xero readback: **PAID**, total £156, tax £0, paid £156, due £0.
- Xero payment: `3cc43827-64f1-422e-8bec-a49ab08a25d5`, dated
  15 October 2026, with the exact Stripe PaymentIntent reference.
- Destination readback: both invoice links/numbers persisted; accounting failure
  fields cleared only after provider settlement evidence.
- Membership payment status remained `paid`; paid timestamp, economics, term,
  and existing `scheduled` lifecycle status were not altered.

## Recorded failure

The original error was:

> Stripe payment recovered before its accounting invoice was created. Retry invoice creation from the membership record.

The history note says reconciliation reconstructed the record after checkout
confirmation failed. This establishes the missing accounting stage, not the
underlying reason the original checkout confirmation failed. No historical
runtime-error claim is made.

There was no accounting queue owner, linked invoice, billing agreement, or
matching form submission. The Stripe metadata nevertheless identified the
form-membership payment flow and its saved quote. A submission-only origin
lookup is therefore insufficient to recover this particular purchase.

## Recovery and verification

`scripts/recover-bnms-member-invoice.mjs` defaults to dry-run. It pins the
destination, tenant, member, history, Stripe intent, quote, Xero company and
contact. It locks the history row, checks the saved amounts and Stripe receipt,
checks for other recovery owners, discovers exact-PI invoices, and rejects
unexplained recent invoices on the verified contact.

The dry-run passed before applying. Recovery used the existing
`createXeroMembershipInvoice` and `settleFormStripeXeroInvoice` helpers:
explicit zero-rate tax, saved nominal code and description, verified existing
contact without contact mutation, provider idempotency keys, and exact-PI
discovery evidence. Settlement recorded the already-collected Stripe payment
in configured Xero clearing account 600 using the original Stripe date.
It did not collect money.

After commit, a fresh dry-run found the same invoice, and independent REST and
Xero reads confirmed linkage and settlement. Syntax checking passed. This was
a live narrowly scoped operational recovery, not a mocked regression result.

The deployed member URL was checked but returned the sign-in page. No session
was fabricated or authentication bypassed. The signed-in membership tab was
**not visually verified**. Its source displays “Invoice failed” only when the
invoice ID is absent and accounting status is failed; neither is now true in
the verified destination record.

## Change boundaries

Only invoice linkage/provider fields and accounting failure fields on the
identified history record were updated. No new card charge, unrelated email,
membership eligibility change, refund, or tenant-wide repair was performed.
Xero authentication was refreshed through the existing helper as necessary.

No application deployment was performed or required for this data recovery.
**No database migrations were needed or applied; none remain pending for this
recovery. SOURCE was untouched.**

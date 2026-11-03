# Form membership voucher checkout

## Release state

The connected form checkout is implemented. The three connected-checkout
migrations were applied atomically to pinned DEST on 2026-11-03:

- `202611090001_form_voucher_payment_evidence.sql`
- `202611090002_form_voucher_renewal_routing.sql`
- `202611090003_form_voucher_connected_readiness.sql`

The new `form_membership_voucher_checkout_ready_v2()` capability is enabled.
The original readiness function deliberately remains **false**, so an older
deployment cannot expose its incomplete checkout. Deploy the matching code
before member testing.

No live payment, voucher redemption, membership change or email was initiated
to verify this release.

## Connected journey

- Members select one payment card and any combination of eligible vouchers.
  Selection updates the displayed estimates; the server revalidates the final
  credit and payment arrangement.
- Before checkout opens, the owning form saves a draft. It then saves the
  checkout's non-secret record ID in the payment answer.
- Stripe authentication returns to the fee-token confirmer, not the ordinary
  form payment handler. The return-to-form link includes the saved draft.
- Embedded forms open checkout in a separate tab and retain the original form.
  The member returns to that form to finish submitting.
- The saved checkout is checked against the authenticated member, tenant,
  original form and payment field. The form can recognise its completed
  purchase even after that purchase has become the member's current term.
- Submission checks the saved financial records again. Browser flags and
  URL parameters cannot establish paid or monthly-setup status.
- Monthly setup is distinguished from an actual paid instalment.
- Cancellation remains blocked for committed or uncertain payments. A bound
  checkout prevents another route from changing or releasing its election.

## Post-grace renewals

The payment-dated finalizer now supports cash plus voucher credit and
credit-only completion. Separate protected evidence preserves actual cash,
credit and gross entitlement rather than representing gross value as cash.

Upfront completion applies confirmed service dates and the existing voucher
completion writer in one transaction. Replays do not consume credit twice.
Funded monthly callbacks use the protected date writer for the linked
membership, agreement and plan. A zero-cash first variable collection uses
the ledger's settlement event, not a fabricated provider payment.

Variable monthly credit remains spread across the membership period. The
original purchased period remains identifiable after payment-date changes;
only the exact before/after term-key pair in the protected date receipt is
accepted.

## Verification boundaries

Automated checks cover authenticated discovery, ownership and form scope,
selected payment/voucher payloads, return-path safety, provider timestamp
handling, settlement recovery, real PostgreSQL date/immutability guards,
cash-plus-credit and credit-only completion/replay, and access permissions.

The composite date/completion test runs the real completion writer and
immutable guards. It substitutes only the credit-ledger boundary; the
separate voucher settlement suite tests the real ledger.

Live verification confirmed RLS and service-only financial RPCs, with no
anonymous/authenticated execution or evidence writes. No synthetic evidence
was inserted into DEST.

These checks are **not** a live Stripe/GoCardless payment or a signed-in
production browser test. Controlled checks after deployment should include:
upfront partial/full credit; monthly card and Direct Debit; post-grace dates;
provider authentication/return; reopening a saved draft; cancellation before
payment; and delayed webhook/repeated confirmation.

## Emergency pause

Disable new connected checkout through the v2 readiness function if necessary.
Keep the settlement handlers and evidence tables in place for in-flight
payments. Do not delete financial evidence or revert database protections to
roll back the UI.

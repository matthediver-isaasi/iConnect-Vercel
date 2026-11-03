# Form membership vouchers: staged, not enabled

The FormBuilder Membership Payment field now discovers personal membership
vouchers using the authenticated payer and the selected schedule's currency.
It shows loading, no-credit and failure states separately.

The credit-checkout bridge is **not enabled**. Do not describe the full form
voucher feature as complete or ready for member payment testing.

## Applied storage

`202611080001_form_membership_voucher_checkout.sql` was applied to the pinned
DEST Supabase project on 2026-11-03 after isolated database tests.

Verification confirmed RLS enabled, no anonymous/authenticated table reads or
binding RPC execution, service-role binding execution, zero bridge rows, and
`form_membership_voucher_checkout_ready()` returning **false**.

No member, membership, voucher balance or provider payment was changed.

## What the draft connects

- A form successor election binds to one shared fee-token credit checkout.
- Binding claims the existing owner/year payment guard before exposing checkout.
- Repeated binding returns the same token.
- Credit history and monthly agreements carry the election provenance.
- The shared fee page can render within the form and restrict the payment mode.
- Cancellation refuses committed, pending or uncertain provider outcomes.
- A released checkout retains its bridge audit row.
- The selected payment card and voucher IDs are sent to the authenticated form
  endpoint; selection is rechecked against current server-owned discovery before
  a checkout is bound.
- A bound checkout carries the selected voucher IDs into the shared fee UI.
  Confirmed upfront/credit-only completion asks the parent form to refresh its
  authoritative membership record. Payment-method switching is disabled while
  this checkout is open.

These UI connections do not enable the gate and are not proof of completed
hosted-return or monthly FormBuilder submission integration.

## Required before enabling

1. Complete and test the provider-return and FormBuilder submission handshake:
   the saved form must recognise both credit-only completion and funded monthly
   setup from authoritative records, not URL flags or client assertions.
2. Finish and test payment-dated post-grace credit finalization. The draft
   intentionally rejects this path: cash plus credit must reconcile against the
   reserved gross entitlement, with atomic membership/agreement/plan service dates.
3. Exercise the actual elected-history and monthly voucher SQL together. The
   isolated bridge test checks its locks/grants/claims, not all purchased-term
   triggers or provider callbacks.
4. Test switching modes and returning to the original form after hosted Stripe
   or Direct Debit, including voucher release, stale quotes, browser refresh,
   provider timeout and delayed webhook recovery.
5. Only then add an explicit rollout migration changing readiness to true.

Existing payment routes remain available; the new credit checkout cannot start
while readiness is false. Deployment alone does not enable it.

## Checks run

- `formMembershipVouchers.test.mjs`
- `formMembershipVouchers.postgres.test.mjs` with isolated local PostgreSQL
- `FormMembershipCredit.test.jsx`
- `MembershipPaymentField.test.jsx`
- `membership-payment-auth.test.mjs`
- Existing membership voucher quote, settlement, monthly, variable and recovery
  unit suites

These checks are not live-provider or signed-in production browser verification.

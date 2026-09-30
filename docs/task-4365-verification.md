# Stripe membership completion verification

## Isolated checks completed

- Production build: `npm run build` passed (existing large-chunk warnings remain).
- Server tests: 158 passed across the monthly confirmation evidence/lifecycle,
  stateful form finalizer, Stripe monthly processor, monthly recovery, and
  monthly Direct Debit confirmation suites.
- Shared return library: 21 passed.
- Hook/component tests: 4 passed, including React StrictMode async completion,
  concurrent recheck deduplication, bounded polling cleanup, and setup-only
  refresh resumption.
- Full-page browser tests: 6 passed across standalone and embedded form routes.
  All API/provider data requests were mocked. They verify pending → refresh →
  finalizing → safe recheck → paid; setup without collection; blocked and
  recoverable accounting outcomes; URL cleanup; no persisted Stripe secret; and
  no request to restart checkout.
- Preview screenshot: the missing-submission return displays neutral payment
  status without claiming Direct Debit. No confirmation was invoked for it.
  This is the new local preview capture at
  `/embed/form/payment-status-check?payment_intent=orphan`, not the original
  user-uploaded incident screenshot, which correctly remains pre-fix evidence.
- Whitespace/diff validation passed.

The regression commands are:

```sh
node --test api/_lib/formMonthlyConfirmLifecycle.test.mjs \
  api/_lib/formMonthlyCardFinalize.test.mjs \
  api/_lib/stripeMonthlyCard.test.mjs \
  api/_lib/monthlyMembershipRecovery.test.mjs \
  api/public/form-payment.monthly-direct-debit.test.mjs
node --test client/src/lib/formPaymentReturn.test.mjs
npx tsx --test client/src/components/forms/FormPaymentReturn.test.jsx
npx playwright test --config tests/form-payment-return.config.mjs
npm run build
```

## What these checks do not prove

These tests use isolated provider/database fakes; they are not evidence of a
fresh payment or invoice in Stripe/Xero. The full confirm route constructs its
provider clients directly; its evidence helper, finalizer, processor, and
browser contract are tested separately rather than as a live end-to-end call.

The read-only provider and destination-database evidence is documented
separately in `task-4365-diagnosis.md`. No reported-record recovery, replay,
repair, cleanup, refund, or manual paid-status change was performed.

## Approval required for external verification

The changes have not been deployed. Fresh deployed end-to-end verification
still needs an approved test target. The incident tenant has Stripe test mode
but a non-demo Xero connection. A fresh successful membership can create real
Xero invoices and configured membership/email side effects. This must not be
treated as a harmless provider-only sandbox test.

Use an approved isolated tenant with Stripe test mode and a Xero Demo Company,
or obtain explicit permission for the non-demo accounting writes. Preserve the
agreed pricing, activation policy, dates, and per-instalment invoicing mode.
Use new submissions only; never replay the reported submission. Verify the
deployed frontend/handler version, the first collection, intended member and
membership linkage, instalment invoice, duplicate-free repeated confirmation,
and background completion without a browser return.
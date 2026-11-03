# Saved renewal voucher checkout verification

## Incident evidence — 2026-11-03

Read-only investigation used the member record ID supplied by the owner.
REST was pinned to production destination `lvmzliemqnieeoruhkik`; schema
inspection used the existing destination-pinned, verified-TLS SQL connection
inside `BEGIN READ ONLY`. The Supabase integration itself denied permission,
so no conclusion was drawn from its failed lookup.

The bounded inspection found:

- One pending member-owned fee token, with the correct tenant, member, form
  and membership-payment field identifiers.
- An unreleased bridge to a reserved, upfront, form-origin election whose
  payer matches the member.
- One matching saved draft retaining that exact checkout record ID. The
  persisted draft had only the payment answer; this investigation does not
  establish whether any additional answers were previously entered.
- No settlement rows for that checkout, no linked history and no recorded
  Stripe intent/attempt on the token at inspection time.
- The election's saved renewal state is `eligible_renewal`, not
  `post_grace_renewal`. Do not change the purchased terms merely because the
  incident was described as an expired-membership renewal.
- The connected readiness function is enabled. The installed binder did not
  check form/field identifiers.

No resume capability, contact details or live record identifiers are retained
here. No financial records, voucher balances, provider state or messages were
changed. Database absence of a Stripe attempt is **not provider evidence that
the member was uncharged**.

## Confirmed code defect versus remaining uncertainty

`MembershipPaymentField` appended `formId` and `paymentFieldId` in both its
ordinary override query and its saved-checkout query. The repeated keys parse
as arrays rather than strings in the API query contract. Strict comparison
against the correctly stored scalar identifiers then fails. The query
regression test reproduces that exact shape; the mounted component test
exercises the corrected request.

The affected live record is scoped correctly: missing legacy metadata is not
its observed defect. No browser network capture from the original failing
session was available, so its exact historical request/database response is
not independently attested. A database outage or older deployed bundle cannot
be ruled out solely from later reads. The new errors distinguish malformed
scope (400), unverified/mismatched checkout (409) and retryable database
verification failure (503), without exposing database internals.

## Release requirements and safe recovery

1. Merge the frontend and API fix together. This fork has not been published.
2. Apply `202611100004_form_voucher_scope_verification.sql` through the normal
   reviewed destination migration process. It is prepared, **not live-applied**.
   It checks new binding scope against the tenant's persisted form/field and
   rejects replay from a different scope. Its guarded function patch preserves
   the installed post-grace routing, locks, financial fences and service-only
   grants. It modifies no existing checkout metadata or financial rows.
3. Verify the actual serving bundle includes the single-query builder; a
   source merge alone is not evidence of rollout.
4. Reopen the existing saved draft as the same authenticated member and use
   **Check renewal status**. Do not clear its payment answer, recreate its
   checkout or cancel the election. The inspected checkout has the scope needed
   to resume without a data repair once the fixed reader is serving.
5. Recheck authoritative settlement/provider state before any proposed
   financial recovery. If uncertainty remains, stop for separate approval.
   Missing/partial legacy scope remains a support escalation: browser IDs and
   editable draft answers are not trusted provenance for a metadata backfill.

This change does not authorize charging the member, sending messages, applying
credit, cancelling an attempt or repairing live financial records.

## Verification

Passed isolated checks:

```
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  api/_lib/formMembershipVouchers.test.mjs \
  api/_lib/formMembershipVouchers.postgres.test.mjs \
  client/src/lib/formMembershipFeeQuery.test.mjs \
  client/src/lib/formVoucherReturn.test.mjs

node scripts/run-isolated-tests.mjs node --test \
  client/src/components/forms/MembershipPaymentField.voucherRestore.test.mjs

node scripts/run-isolated-tests.mjs node --test \
  api/public/form-submission.voucher.test.mjs

node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  api/_lib/postGraceStripeFinalization.test.mjs \
  scripts/post-grace-atomic-dates.postgres.test.mjs \
  api/_lib/membershipVoucherSettlement.postgres.test.mjs
```

Coverage combines JS binding through real PostgreSQL persistence and restored
receipt reads; same-checkout replay; foreign tenant/member/form/field rejection;
missing/partial scope; service-role permissions; retryable lookup failures;
mounted refresh/remount retaining answers and purchase ID; checkout-scoped
provider-return navigation; real post-grace date/completion transactions; and
real voucher-ledger concurrency/replay tests. The date/completion suite stubs
the credit-ledger boundary, covered separately by the real ledger suite.
This is layered isolated coverage, not a single end-to-end hosted-provider
journey or proof of a live financial outcome.

The real submission handler/processor fixture additionally verifies
authenticated paid-receipt submission and idempotent replay, preserving other
answers, and rejects guests, unpaid receipts, foreign scope and database
outages before submission effects. Provider APIs and delivery remain isolated.

The development server starts successfully. Preview renders an existing
tenant-resolution error on its default host, so the signed-in renewal UI was
not visually verified there. No authentication bypass or environment retargeting
was introduced. The mounted UI fixture is independent of that environment.

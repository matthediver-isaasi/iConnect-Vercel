# Training-fund accounting recovery (staged)

New adoption is **disabled by default**. No production database migration,
provider call, charge or rollout setting was changed during implementation.

Apply through the approved DEST-only migration process, in order:

1. `202612050001_accounting_request_queue.sql`
2. `202612050002_accounting_request_gc_preparation.sql`
3. `202612050004_training_fund_accounting_continuation.sql`

The existing training-fund schema and paid-credit function are prerequisites.
The notification migration numbered 003 is independent.

Only after migration and continuation verification, explicitly set all three:
`ACCOUNTING_REQUEST_QUEUE_ENABLED=true`,
include `training_fund_purchase` in `ACCOUNTING_REQUEST_QUEUE_SOURCES`,
and `ACCOUNTING_TRAINING_FUND_CONTINUATION_VERIFIED=true`.
Do not set the verification flag merely because deployment succeeded.

## Authority and recovery

Acceptance creates the purchase, original invoice inputs (including dates,
settings, contact details and provider/company binding), checkout identity and
queue entry in **one database transaction before provider preparation**.
Duplicate requests scoped to tenant/member reuse the same purchase; changed
purchase inputs are rejected. Accepted ownership is resumed even with flags OFF.
No historical purchase backfill is authorized.

The original PO input remains frozen in accounting authority, while the existing
pending-PO service may fulfil a blank PO on a linked purchase and clear its
outstanding-PO flag. It cannot replace a supplied PO through that fulfilment path.

The shared worker prepares and creates the invoice for both Xero and QuickBooks.
Provider uncertainty/throttles use the existing queue discovery/cooldown rules.
Linking an invoice and adding invoice-only pending funds is atomic and once-only.
Available funds are never increased by this continuation. The existing confirmed
Stripe payment or paid-invoice reconciliation remains the paid-credit authority.

Card setup happens on authenticated checkout continuation after invoice linkage,
not automatically in the background worker. Its original parameters and stable
Stripe key survive crashes. The account/public-key binding cannot change after
setup starts. Lost local intent linkage retries within 23 hours use the same key;
older uncertain attempts stop for review rather than reusing a potentially expired
key. Known intent IDs are retrieved, not recreated. A succeeded intent resumes
confirmation instead of requesting another payment.

The modal displays saved/queued/review state and resumes the same request across
close/reopen and page refresh in that browser tab. Session storage holds only
checkout inputs and request identity, scoped by member/organisation; it stores no
Stripe secret. This is not a cross-device abandoned-checkout management screen.
Ordinary legacy purchases retain their existing writer while adoption is OFF.
Card accounting settlement still uses the existing provider settlement helper
(now with a stable operation key); this does not claim shared-queue adoption of
every card settlement or repair of historical failed payment postings.

## Verification

Run `node scripts/run-isolated-tests.mjs --allow-local-postgres node --test
api/_lib/trainingFundAccountingContinuation*.test.mjs
api/_lib/accountingRequestQueue.test.mjs api/_lib/accountingRequestProviders.test.mjs
api/_lib/accountingQueueProductLinks.test.mjs api/_lib/accountingQueueIntegration.test.mjs
api/_lib/accountingSourcePreparation.test.mjs`.

Tests use mock providers and disposable PostgreSQL, not live accounting or Stripe.
Before activation, verify service-role grants, exact provider bindings, worker
link retries, browser resume, and real sandbox card/invoice settlement on the
deployed schema. Keep all adoption controls disabled until this is complete.

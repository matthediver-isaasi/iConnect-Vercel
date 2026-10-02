# GoCardless accounting queue contract

## Source and accounting operations

- The exact source type and rollout allowlist entry is `gocardless_payment`
  (singular); source ID is the canonical local `gocardless_payments.id`.
  Webhook, accounting reconciliation and central retry converge on that owner.
- Standard per-instalment requests create an invoice and its payment through
  Xero or QuickBooks. Annual collections use operation `payment` against the
  exact existing invoice linked to the original membership history. A genuine
  previously linked instalment invoice also uses payment-only operation.
- Missing annual invoice authority stays failed/waiting on the payment mirror,
  without provider calls. It is not enqueued as payment-only until an actual
  `snapshot.existingInvoice.id` exists, and is never reported as posted.
- Source linkage is accounting-only. Only verified invoice/payment results and
  persisted, read-back source links authorize `posted`. The facade preserves
  `payment_recorded`; pending or review is not successful posting.

## Durable preparation and provider boundary

`accountingQueueGoCardless.js` captures original agreement, canonical collection,
source linkage, economic context, QBO environment and dedicated bank setting.
Local context/settings lookup failures are retained as preparation evidence
rather than passed to a legacy writer. The original
`snapshot.payment.bankSetting = { key, value }` uses
`xero_gocardless_bank_account_code` or
`quickbooks_gocardless_bank_account_id`; it never falls back to Stripe.

The original request commits with `snapshot.preparation: true` before provider
contact, tax, account, invoice or payment requests. `adapter.prepare(row)` uses
`prepareGoCardlessSourceRequest` and the provider preparer in
`accountingGoCardlessPreparation.js`. Separately derived `args`, `collection`
and `existingInvoice` inputs do not mutate the original row used by fences.
`resolveGoCardlessFrozenBank` resolves only the original bank code/ID through
bound provider reads. It does not reread today's setting.

Preparation returns a complete snapshot with `preparation: false`, persisted
once as `resolved_snapshot`. Financial requests replay its exact envelopes and
provider idempotency keys. Xero invoice preparation uses `markAsPaid: true`
with `prepareOnly: true` to produce an AUTHORISED invoice, without posting it.
Every provider/auth request is binding-checked, lease-fenced and bounded.
Preparation retains the first transport error so legacy nonfatal contact/tax
catches cannot swallow a 429 embargo. Unknown financial writes require
discovery; they are not blindly recreated.

## Safety exclusions and existing owners

- **BNMS dedicated accounting is not transferred wholesale.** For a fresh
  source while adoption is OFF, the existing legacy BNMS route and its
  adoption/release, canonical payment, reservation, pinned bank/contact/revenue
  and imported invoice-operation checks remain in force.
- When adoption is ON, those checks still run before accepting new requests.
  A BNMS request that passes the source checks and reaches central preparation
  is held for durable review as
  `GC_QUEUE_BNMS_EXISTING_SETTLEMENT_OWNER`, including payment-only requests.
  It does **not** fall back to the legacy writer. A request failing earlier
  BNMS authority checks remains a source failure without provider posting;
  do not describe every such failure as an enqueued review row.
- An accepted queue owner continues to own retries even after flags are
  switched OFF. Turning adoption OFF therefore does not release an accepted
  BNMS review request to its old writer.
- Catch-up arrears retain the existing per-period allocation writer, including
  its existing BNMS exclusions. Generic collection posting rejects payments
  owned by `membership_monthly_collection_intent`; it cannot aggregate-post
  an already allocated collection. Arrears allocation ownership is not migrated.
- Legacy failed/in-flight/unpaid writers with uncertain external effects and
  no accepted queue owner receive durable review, not a fresh financial
  identity. Proven missing-invoice waits are distinguished from uncertain
  legacy writes.
- The bounded accounting retry selector includes annual and instalment
  failed/unpaid/stale-posting obligations. This is not a broad historical replay:
  it does not collect Direct Debits, replay activation or award benefits.

## Staged rollout — OFF

New source adoption requires both `ACCOUNTING_REQUEST_QUEUE_ENABLED=true` and
`gocardless_payment` in comma-separated `ACCOUNTING_REQUEST_QUEUE_SOURCES`.
Already accepted identities are looked up before current preparation and remain
centrally owned with either flag OFF. Only a missing queue schema is tolerated
for fresh OFF-mode requests; operational lookup errors fail closed.

Do not enable production before separately reviewing and applying, in order:

1. `supabase/migrations/202612050001_accounting_request_queue.sql`
2. `supabase/migrations/202612050002_accounting_request_gc_preparation.sql`

Neither migration was applied by this implementation. No production environment
settings or provider records were changed.

## Verification

The latest main-agent combined isolated run passed **263/263 tests**. Combined
GC tests exercise the real producer, queue engine, default integration,
membership preparation, provider adapters and source linker for both providers
and both operations. Only database/RPC and external HTTP boundaries are fixtures.
Coverage includes preparation/contact/tax/financial 429s, post-success readback
429s, lost responses, frozen bank-setting changes, identical retry payloads/keys,
verified-only source posting and absence of collection/activation/workflow
effects. These tests do not establish deployed migrations, scheduler behavior
or live provider success.
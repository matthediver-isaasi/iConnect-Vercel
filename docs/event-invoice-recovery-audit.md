# Event invoice recovery audit

Status: implementation extended to future QuickBooks checkouts; live provider
posting is not claimed by offline tests. The initial findings below describe the
pre-change audit.

## Implemented recovery boundary

Xero retains its existing immutable event authority and writer. QuickBooks now
captures new checkout intent in a dedicated immutable event operation and the
shared accounting queue, with preparation, invoice, payment and link stages.
The event cron drains accepted QuickBooks requests independently of shared-queue
adoption flags. No addition to `ACCOUNTING_REQUEST_QUEUE_SOURCES` is necessary.

The existing QuickBooks settings screen supports dedicated event item, tax code
and Stripe deposit-account mappings. Missing mappings stop preparation and retry
without financial writes. Existing nonempty checkout mappings cannot be replaced
by later settings; resolved envelopes are immutable. No membership-item fallback
or automatic historical capture is performed.

Both booking handlers retain their existing confirmation-email calls, after
durable capture. Recovery does not rerun checkout notifications. This change does
not introduce a separate invoice-email send or claim provider-email delivery.

Migration: `202612050005_event_accounting_queue.sql`; destination-only runner:
`node scripts/apply-event-accounting-queue.mjs`. The additive migration creates no
historical accounting requests. Before publishing, apply it to the destination;
older Xero workers remain compatible. Applied to pinned destination Supabase on
2026-10-08; post-application read-only verification found zero captured event
operations and confirmed authenticated browser roles cannot call capture.
No migrations remain unapplied for this change.

Verification: the expanded event/provider/queue suite passed 184 tests, including
isolated PostgreSQL capture, immutability, payment ownership, grant and linkage
checks, QuickBooks preparation throttles and configuration UI source tests.
Checkout-to-queue cases cover QuickBooks tenants without the Xero enable flag,
Xero-style ticket VAT identifiers mapped to different QuickBooks IDs, and a
configured rate that disagrees with immutable checkout tax evidence.

## Read-only live evidence (2026-10-08)

- Vercel reported the production deployment READY and its active cron definitions
  included `/api/cron/reconcile-event-invoices` at `*/5 * * * *`.
- Destination Supabase was inspected in a `BEGIN READ ONLY` transaction with an
  eight-second statement timeout. At 11:44:29 UTC the event monitor recorded
  `last_started_at=11:40:34.363` and `last_success_at=11:40:34.613`.
  The passive health function returned `healthy`.
- Aggregate event recovery state: 14 complete, 11 needing review for
  `snapshot_unavailable`, one explicitly excluded test booking.
- Active accounting-provider settings included two Xero tenants and one
  QuickBooks tenant. The QuickBooks tenant had 14 ordinary and one complex-event
  booking rows; these counts do **not** establish invoice eligibility or missing
  provider documents.
- The QuickBooks configuration contained a membership item setting but no
  configured event-item or settlement-bank setting. Membership-item presence is
  not authority to post event revenue to that item.
- The shared accounting queue contained Xero GoCardless work, not event work.
  No recovery cron, provider write, historical backfill, collection instruction,
  deployment or migration was initiated by this audit.

These observations establish recent live execution of the event worker, not
QuickBooks coverage, delivery success, or correctness of every completed invoice.

## Coverage and gaps

| Boundary | Current evidence | Remaining requirement |
| --- | --- | --- |
| Checkout capture | Both booking handlers call `enqueueCheckoutEventInvoice` after booking/credit/allocation commits | `loadContext` explicitly excludes QuickBooks |
| Provider binding | Event snapshot, connection lock and transport pin Xero connection and organisation | QuickBooks realm/environment must have equivalent immutable authority |
| Tax preparation | Xero tax resolution freezes evidence before invoice writes and persists throttling | QuickBooks event item/tax/customer preparation is not integrated |
| Invoice/payment stages | Separate start-write markers, invoice journal, provider discovery and settlement validation | Event implementation still uses Xero payloads and identifiers exclusively |
| Booking linkage | Database finish links the full group atomically using Xero columns | Provider-neutral linkage must preserve existing IDs and reject conflicting links |
| Shared queue | Generic queue/provider tests cover Xero and QuickBooks | `assertAccountingSource` has no event source; queue rollout flags do not control the separate event path |
| Delivery | Existing checkout confirmation emails remain outside recovery | No event invoice-delivery continuation or acceptance receipts were found in the recovery path |
| Historical recovery | Cron defaults to future operations only | Reconcile existing documents and obtain original authority before any separately approved backfill |

## Verification

The initial five-file offline run passed 107 tests:

```sh
node --test \
  api/_lib/eventInvoiceRecovery.test.mjs \
  api/_lib/eventInvoiceProducer.test.mjs \
  api/_lib/eventInvoiceRecoveryXero.legacy.test.mjs \
  api/_lib/accountingRequestProviders.test.mjs \
  api/_lib/accountingRequestQueue.test.mjs
```

Additional event regressions cover invoice rejection, settlement rejection,
bank-preparation throttling and failed booking linkage after successful payment.
They assert original settlement date/account/amount, unchanged snapshots,
stable provider keys and no replay of successful invoice/payment stages.
Mocks explicitly model SQL's rejected-stage release; they do not prove live
provider throttling, scheduler authentication, or successful email delivery.

The final expanded run passed **127 tests, zero failures and zero skips**,
including `api/_lib/eventInvoiceFutureTax.test.mjs` and the isolated PostgreSQL
suite `api/_lib/eventInvoiceRecovery.postgres.test.mjs` in addition to the five
files above. The PostgreSQL suite uses a temporary isolated database, not the
destination database queried for the live audit.

## Original completion requirements (audit baseline)

Do not mark two-provider recovery complete based on generic QuickBooks adapter
tests or the healthy Xero heartbeat. Implement and verify event-specific capture,
preparation, settlement ownership, linkage and notification continuation for both
providers. Existing accepted operations must retain ownership across rollout
changes. Do not migrate existing Xero operations to a second writer or automatically
replay the QuickBooks booking rows discovered during this audit.

QuickBooks event item/revenue and Stripe deposit-account policy must be explicit;
do not infer it from the membership item or Xero's sales-account default.
At the time of the original read-only audit, implementation and database changes
were outstanding. See the implementation boundary above for the subsequent work.

# Sales grouped bundle billing

**Created / updated:** 2026-10-18  
**Author:** Replit Agent  
**Module:** Sales catalogue, proposals and accounting

## Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Financial and calendar rules](#financial-and-calendar-rules)
4. [Settings and catalogue editing](#settings-and-catalogue-editing)
5. [Quote and acceptance flow](#quote-and-acceptance-flow)
6. [Accounting, delivery and operations](#accounting-delivery-and-operations)
7. [Database contract](#database-contract)
8. [Controlled rollout](#controlled-rollout)
9. [Verification and troubleshooting](#verification-and-troubleshooting)

## Overview

Grouped billing is an explicit **per-version opt-in**, not a change to the
independent bundle selling price. Each accepted bundle-line/group produces its
own scheduled invoice. Standalone and legacy ungrouped lines share an explicit
remainder invoice. Historical unscheduled proposals retain manual whole-sale
invoicing; adding catalogue groups never opts them in.

Issue delay and payment terms are separate. “Issue 10 days after acceptance,
14 days to pay” is not the same as “issue on acceptance, 24 days to pay”.
All arithmetic uses calendar days. There are no percentage deposits, nested
groups, product splitting, automatic collection, reminder or credit-note flows.

## Architecture

| Area | Main files |
|---|---|
| Configuration validation | `shared/salesBillingConfiguration.js`, `shared/salesContracts.js` |
| Exact quote allocation | `shared/salesBilling.js`, `api/_lib/salesQuote.js` |
| Settings / atomic catalogue writes | `api/_lib/salesFoundation.js`, `api/_lib/salesCatalogue.js` |
| Settings and groups UI | `BillingPresetSettings.jsx`, `BundleBillingGroups.jsx`, `client/src/pages/sales/Catalogue.jsx` |
| Quote and public schedule UI | `QuoteBillingSettings.jsx`, `BillingSchedule.jsx`, `QuotesWorkspace.jsx`, `PublicSalesQuote.jsx` |
| Frozen PDF content | `api/_lib/salesQuotePdf.js` |
| Dispatch, delivery and read model | `api/_lib/salesInvoiceSchedule.js` |
| Provider preparation / ownership | `salesAccounting.js`, `accountingQueueIntegration.js`, `accountingQueueProductLinks.js` in `api/_lib/` |
| Central provider writer | `api/_lib/accountingRequestQueue.js`, `accountingRequestProviders.js` |
| Scheduled sweep | `api/cron/sales-invoice-schedule.js`, `vercel.json` |
| Operations UI / API | `InvoiceSchedulesPanel.jsx`, `useInvoiceSchedules.js`, `api/sales/accounting/[...path].js` |
| Reviewed migration entrypoint | `scripts/apply-sales-grouped-billing.mjs` |

Frontend component paths above are under `client/src/components/sales/` unless
otherwise specified. Catalogue settings reuse the existing versioned settings
RPC, permissions, naming and catalogue-visibility configuration.

## Financial and calendar rules

1. Each component belongs to exactly one flat group. Existing duplicate-product
   rules still apply to the entire bundle.
2. Group `allocatedMinor` amounts sum exactly to the bundle's independent
   pre-discount, pre-tax selling price. A deposit consumes part of that price.
3. The UI can suggest proportional amounts from component standard prices ×
   quantities. When every component value is zero it suggests equal shares.
   Remainder pennies follow stable group order. Suggestions require review.
4. The server applies group weights to the already-calculated quote line
   net/tax/gross after negotiated prices, quantity and discount. Integer/BigInt
   arithmetic and deterministic largest remainders avoid floating-point money.
5. Groups keep the charged line's provider tax identity and rate. A remainder
   keeps its separate accepted source lines, including mixed tax treatments.
   Unsupported provider rounding fails validation, never changes accepted totals.
6. Group totals reproduce each line and the entire proposal. A zero-gross group
   stays visible as **No invoice required** and does not suppress fulfilment.
7. `timing` is `{kind:"acceptance",days:N}` or
   `{kind:"fixed",date:"YYYY-MM-DD"}`. `paymentTerms` is a frozen named preset
   `{id,name,days}` and is independent of `timing`.
8. Tenant IANA timezone is resolved into the quote snapshot. Missing timezone is
   explicitly displayed as UTC fallback. Relative eligibility uses the accepted
   timestamp's local date; a fixed date already passed is immediately eligible
   only after durable acceptance.
9. At the first accepted issuance command, issue date is the current local date,
   not an overdue planned date. Due date is issue date plus payment-term days.
   Both are frozen with accounting ownership so retries cannot move them.

## Settings and catalogue editing

`/sales/settings` has separate issue-delay and payment-term preset lists.
Presets have stable IDs, names, nonnegative whole-day values, active flags and an
optional active default per list. Deactivation prevents new selections; existing
saved selections retain their named values. A failed settings query is not an
empty list and must not erase a saved choice.

Settings PATCH uses `expectedVersion`. Stale edits return 409 and do not
overwrite unrelated settings. First inserts use the existing singleton/CAS
contract. Billing updates do not reset proposal naming, visibility or task-list
settings.

`/sales/bundles` supports group reorder, rename, fixed dates or acceptance delay,
payment terms, exact allocations and product reassignment. Removing a populated
group requires an explicit destination; neither products nor allocated money
are silently removed. Creation and modification persist bundle, composition,
groups and audit atomically. Existing catalogue management/pricing permissions
apply; group allocations do not introduce a weaker pricing permission.

Copies retain configuration with new local group identities and no financial
history. Create-only copy provenance is checked against the tenant-owned source,
allowing unchanged deactivated preset snapshots to survive duplication. The
provenance metadata is stripped before storage. Archive/restore retains groups.

## Quote and acceptance flow

```text
Catalogue / named presets
  → server-calculated draft billing_schedule
  → issued immutable proposal version + PDF / public view
  → public acceptance OR staff acceptance
  → accepted history + commercial sale + schedules in one transaction
  → due schedule dispatcher
  → durable accounting request
  → central provider writer / readback / source link
  → independent invoice PDF email delivery
```

The editor sends `scheduledBilling` and, when a remainder is needed,
`remainderPaymentTermsId`. It never supplies authoritative group totals.
Draft hydration retains scheduling choices. Saved remainder terms remain frozen
even when no remainder currently exists, so later editing does not lose the
selection or adopt changed settings silently.

Schedules store the billing-contact email, then customer-contact email, then
organisation email fallback with the corresponding identity. Issued/accepted
versions never look up new catalogue prices, terms or recipients. Missing
recipient evidence blocks dispatch; it is not replaced with an administrator's
address.

Public acceptance already converts within its database transaction. Scheduled
staff acceptance also invokes the same authoritative commercial-sale conversion
inside its transaction, using a version-stable key. Legacy unscheduled staff
acceptance retains its old behaviour. A deferred sale trigger creates each
version/group schedule exactly once. Browser follow-up is not required.

Draft, declined, expired, superseded and unaccepted versions cannot create
schedules. Moving an opportunity to Won is not acceptance. Existing event
allocation and acceptance-task flows execute once per commercial sale, not per
group. Issued snapshot guards check both old and new parents; accepted schedules
cannot be deleted or re-parented.

## Accounting, delivery and operations

`sales_invoice_schedule` is a separate accounting source type with schedule UUID
as source identity. It does not reuse the sale-level idempotency key. Scheduled
sales are rejected by the legacy whole-sale invoice writer at API and database
boundaries.

Provider/company, issue and due dates, accepted economics and command ownership
are fixed before provider effects. The existing central accounting reconciliation
worker owns actual provider writes, discovery, readback and source-link recovery.
Provider document uniqueness remains enforced. Turning off new-request rollout
does not transfer accepted work back to a legacy writer.

Customer ambiguity is visible with candidates. An authorised operator must
choose and confirm a candidate; none is automatically selected. A provider
or company change cannot redirect an in-flight command. Unknown provider outcomes
stay in reconciliation/review, not a new invoice attempt.

After a verified invoice link exists, delivery fetches a PDF from the same
provider/company and uses `sendTenantEmail` with tenant branding and the frozen
recipient. A separate durable delivery claim records provider message evidence.
Definite rejections may retry. A timeout, interrupted send or uncertain outcome
is held for review; a missing audit write is not proof that no email was sent.
Confirmed sends cannot be reset or resent by ordinary retry.

The five-minute Sales sweep dispatches due groups and delivery work in bounded
batches. It catches up overdue groups, isolates row failures, fences concurrent
claims and reports counts. The central accounting cron remains the only provider
writer. A durable tenant cursor visits at most 20 tenants and 100 indexed
candidates per tenant per selection. Worker health includes the last completed
timestamp and result counts. Disabling new dispatch still sweeps already-owned
linked invoice delivery.

The quote/opportunity invoice panel displays planned/actual issue date, due
date, amount, accounting and payment status, provider link, delivery state and
actionable errors. **Reload groups** rereads stored state; **Refresh payment
status** queries the provider. A first invoice does not mean the sale is fully
invoiced; revenue continues to derive from accepted sales, not invoice-row joins.

Endpoints use existing Sales view/accounting permissions and tenant ownership:

| Method | Path / action | Purpose |
|---|---|---|
| GET | `/api/sales/accounting/:saleId?action=schedules` | Grouped status |
| POST | same, `action=retry-schedule` | Safe due-group or definite-failure retry |
| POST | same, `action=refresh-schedule` | Provider-backed payment status |
| GET/POST | `/api/cron/sales-invoice-schedule` | Authenticated sweep |

POST commands require `scheduleId`. Customer confirmation additionally supplies
`providerCustomerId` and `confirmCustomerMatch:true`. Neither manual retries nor
refresh can issue an unaccepted or not-yet-due group.

## Database contract

| Table / field | Purpose |
|---|---|
| `sales_settings.billing_presets` | Versioned tenant named preset lists |
| `sales_catalogue_bundle.billing_groups` | Stable groups, memberships, allocations and saved terms |
| `sales_quote_version.billing_schedule` | Immutable issued financial, timezone and recipient snapshot |
| `sales_invoice_schedule` | Accepted per-version/group authority, planned/actual dates, provider binding, claims, delivery evidence and errors |
| `sales_accounting_invoice_link.schedule_id` | Per-group link; null retains legacy whole-sale identity |
| `accounting_request_queue` | Existing durable provider execution and recovery ownership |
| `sales_invoice_schedule_worker_state` | Service-only tenant cursor and last completed sweep counts |

Schedules use tenant-composite sale/version references and unique
`(tenant_id,quote_version_id,group_id)`. A scheduled link is unique per tenant and
schedule; legacy links remain unique per tenant/sale/provider. Provider invoice
IDs remain unique independently of the source. New tables/RPCs are not writable
by browser roles.

## Controlled rollout

**No external migration or live activation was performed for this implementation.**
The workspace runtime SOURCE database is not an approved migration target.
Schema must precede feature-enabled code on the pinned DEST project
`lvmzliemqnieeoruhkik`.

Pending new migrations, in this order:

1. `202610180003_sales_grouped_billing.sql`
2. `202610180004_sales_billing_configuration.sql`
3. `202610180005_sales_grouped_accounting.sql`

Required existing prerequisites include latest Sales task-list, catalogue atomic
create, visibility and naming migrations, and the accounting request queue plus
durable preparation migrations. Queue files have later date prefixes
(`202612050001_accounting_request_queue.sql`,
`202612050002_accounting_request_gc_preparation.sql`): **do not assume filename
ordering proves these prerequisites are installed**.

Offline inspection:

```sh
node scripts/apply-sales-grouped-billing.mjs --review
```

This prints each file hash and a bundle SHA256 without connecting to a database.
After separate SQL review, explicit owner approval, prerequisite verification and
confirmed backup, the approved operator can use:

```sh
node scripts/apply-sales-grouped-billing.mjs --apply \
  --reviewed-sha256=<independently-reviewed-bundle-sha256> \
  --confirm-destination=lvmzliemqnieeoruhkik
```

The runner only uses verified DEST connection variables with certificate
verification. It rejects enabled Sales automation, locks/preflights the current
contracts, applies all three files in one transaction and checks historical
financial totals and grants. It makes no invoice or email call and does not
activate anything.

New command creation requires all three settings:

| Setting | Required value |
|---|---|
| `SALES_INVOICE_SCHEDULE_ENABLED` | `true` |
| `ACCOUNTING_REQUEST_QUEUE_ENABLED` | `true` |
| `ACCOUNTING_REQUEST_QUEUE_SOURCES` | Includes `sales_invoice_schedule` without removing existing sources |

Keep Sales automation disabled until approved sandbox provider checks, schema,
cron routing/authentication and queue reconciliation are ready. Do not use an
ordinary preview deployment as financial isolation: it can share production
credentials/data. Live activation is a separate approval and deployment action.
Disabling new creation is not permission to forget already accepted queue work.

## Verification and troubleshooting

Isolated commands:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres \
  node scripts/test-sales-hardening.mjs
node scripts/run-isolated-tests.mjs node --test \
  scripts/apply-sales-grouped-billing.test.mjs \
  client/src/components/sales/BillingSettings.mounted.test.mjs
# Separate fully intercepted browser fixture; the Node isolation runner
# intentionally does not permit launching Chromium.
node --test client/src/components/sales/InvoiceSchedulesPanel.browser.test.mjs
```

PostgreSQL tests create disposable local clusters, never external schemas.
Browser tests intercept all requests and exercise production components with
fixtures, not real sessions or financial integrations. Provider tests mock both
Xero and QuickBooks transport. These are not evidence of live provider delivery.

| Symptom | Safe action |
|---|---|
| Stale settings or bundle save | Reload latest version; review preserved draft and retry |
| Preset discovery fails | Retry discovery; do not replace saved IDs with blank defaults |
| Allocations/tax fail | Correct draft allocations before issue; do not round accepted totals differently |
| No recipient / accounting configuration | Review blocked evidence; never guess a recipient or mutate an accepted snapshot |
| Customer ambiguity | Select an offered customer explicitly with accounting permission |
| First invoice exists, others pending | Inspect each group's eligibility and queue state; do not use whole-sale conversion |
| Company changed | Restore original binding or obtain a separately approved financial recovery |
| Unknown provider write | Use central reconciliation; never create a replacement invoice blindly |
| Email attention / interrupted send | Reconcile provider message evidence before any resend |
| No scheduled work starts | Verify schema, flags, source allowlist and authenticated cron wiring |

Production checks still needing approval: destination migration and grants,
authenticated scheduled invocation and operational counts, both provider sandbox
date/tax/customer/PDF behaviour, controlled email receipt in an approved test
inbox, and subsequent live enablement. Do not test by sending real customer
invoices or emails.

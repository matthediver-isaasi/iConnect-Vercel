# Event Invoice Recovery

**Author:** Replit Agent
**Last Updated:** October 2026
**Module:** Event bookings, Xero accounting and operational monitoring

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Checkout Evidence and Eligibility](#checkout-evidence-and-eligibility)
4. [Recovery Lifecycle](#recovery-lifecycle)
5. [Historical Sweep](#historical-sweep)
6. [Configuration and Settings](#configuration-and-settings)
7. [Code Paths and Entry Points](#code-paths-and-entry-points)
8. [Safeguards and Error Handling](#safeguards-and-error-handling)
9. [Frontend UI](#frontend-ui)
10. [Database Tables](#database-tables)
11. [Data Flow Diagrams](#data-flow-diagrams)
12. [External Integrations](#external-integrations)
13. [Configuration Reference](#configuration-reference)
14. [Operational Setup and Rollout](#operational-setup-and-rollout)
15. [Better Stack Monitoring](#better-stack-monitoring)
16. [Safe Manual Review](#safe-manual-review)
17. [Tests](#tests)
18. [Troubleshooting](#troubleshooting)

---

## Overview

Event invoice recovery separates successful event registration from the availability of Xero. Standard one-off and complex-event checkout record a durable invoice operation after the required booking, capacity, credit and allocation work succeeds. A scheduled worker later reconciles or creates the invoice and, for an evidenced captured Stripe payment, records its Xero settlement. An accounting failure must not undo a confirmed booking, debit credits again, refund a valid payment or ask the purchaser to pay again.

The core principle is **one durable operation and one accounting writer** per application tenant, booking source and booking group. Immutable checkout evidence determines the purchaser, prices, VAT treatment, dates, currency, accounts and provider connection. Database leases fence workers; exact remote lookup and persisted write intent prevent uncertain provider responses from authorizing duplicate invoices or payments. We do not rebuild historical invoices from today's catalogue or accounting defaults.

Members see a neutral **Invoice awaited** state while recovery is pending, retrying or awaiting review. Administrators see **Needs attention** for review cases and the next attempt time for automatic work. Public invoice/PO registrations remain outside this mechanism. **Setup status: the migration was applied to production DEST on 1 October 2026.** Its initial health was verified as `never_succeeded`, with an empty queue and no anonymous/authenticated RPC grants. Application deployment and Better Stack monitor configuration remain separate rollout steps; no recovery sweep or provider writes were performed during installation.

---

## Architecture

### Key Files

| File | Purpose |
|------|---------|
| `supabase/migrations/202611300001_event_invoice_recovery.sql` | Queue, connection cooldowns, monitor, mirrored booking fields, immutable evidence, fenced RPCs and aggregate health. |
| `api/_lib/eventInvoiceProducer.js` | Captures purchaser, lines, settings, provider binding and Stripe settlement evidence without Xero calls. |
| `api/functions/[functionName].js` | `createOneOffEventBooking` invokes the standard-event producer after required registration work. |
| `api/public/complex-event-booking.js` | Complex checkout invokes the same producer after required registration work. |
| `api/_lib/eventInvoiceRecovery.js` | Snapshot validation, operation identity, persistence wrapper, fenced processor and bounded reconciliation runner. |
| `api/_lib/eventInvoiceRecoveryXero.js` | Dedicated bounded Xero transport, exact invoice/payment lookups and evidence validation. |
| `api/cron/reconcile-event-invoices.js` | Authenticated GET/POST runner; mandatory `CRON_SECRET`. |
| `api/health/event-invoice-recovery.js` | Public GET-only, aggregate, database-only health check. |
| `vercel.json` | Every-five-minute schedule and 60-second function limit. |
| `api/_lib/database.js` | Server-side Supabase service client. |
| `api/_lib/session.js` | Existing session authentication for invoice downloads. |
| `api/_lib/accountingProvider.js` | Existing provider selection for invoice PDF retrieval; not the recovery writer. |
| `shared/eventInvoiceRecoveryPresentation.mjs` | Shared linkage, group selection, applicability, status and polling rules. |
| `client/src/components/booking/EventInvoiceStatus.jsx` | Neutral member status and administrator status/retry timestamp. |
| `client/src/pages/Bookings.jsx` | Member booking invoice status, polling and view/download actions. |
| `client/src/pages/History.jsx` | Member/organisation history invoice status, polling and view/download actions. |
| `client/src/pages/EventRegistrationReport.jsx` | Administrator invoice status, retry information and exports. |
| `client/src/pages/EventSettings.jsx` | Existing tenant Xero invoice settings UI. |
| `api/reports/event-registration-report.js` | Supplies selected group invoice linkage and mirrored recovery fields. |
| `api/complex-event-bookings/index.js` | Supplies complex booking fields while removing raw accounting/recovery error fields. |
| `api/booking-invoice/[bookingGroupRef].js` | Authorized PDF retrieval for linked standard or complex bookings. |
| `api/_lib/eventInvoiceProducer.test.mjs` | Producer evidence, exclusions, enqueue failure and sole-writer source checks. |
| `api/_lib/eventInvoiceRecovery.test.mjs` | Processor, actual adapter with stub transport, ambiguity, deadlines, auth and health checks. |
| `api/_lib/eventInvoiceRecovery.postgres.test.mjs` | Real isolated PostgreSQL tests for migration, grants, concurrency, fencing, ownership and health. |
| `shared/eventInvoiceRecoveryPresentation.test.mjs` | Presentation applicability, group selection and polling tests. |
| `client/src/components/booking/EventInvoiceStatus.test.jsx` | Component status and privacy tests. |
| `api/complex-event-bookings/event-recovery.test.mjs` | Complex booking response sanitization tests. |
| `api/booking-invoice/event-recovery.test.mjs` | PDF provider pinning and authorization tests. |
| `tests/event-invoice-recovery.spec.mjs` / `tests/event-invoice-recovery.config.mjs` | Offline browser tests mounting the real pages, with network escape blocked. |
| `scripts/run-isolated-tests.mjs` / `scripts/test-support/local-postgres-harness.mjs` | Fail-closed test boundary and temporary UNIX-socket PostgreSQL harness. |

### Design Principles

1. Checkout captures intent without writing to Xero, so provider availability cannot invalidate an otherwise successful registration.
2. One immutable operation owns a tenant/source/group, so repeated enqueue cannot replace historical financial evidence.
3. One connection lease serializes accounting work, so overlapping workers and future targeted processing share the same authority.
4. Each captured Stripe intent has one event-operation owner per application tenant, so changing groups, sources or connections cannot fund another invoice.
5. Every provider request is guarded and every write is journaled first, so a lost lease or ambiguous response cannot silently trigger another create.
6. Historical discovery creates review work rather than reconstructing an invoice, because current settings are not historical evidence.
7. Monitoring exposes only aggregate status, so public health checks cannot disclose purchaser or financial details.

---

## Checkout Evidence and Eligibility

### What We Capture

**`enqueueCheckoutEventInvoice()`** snapshots a version-1 object containing:

- **Provider binding:** the selected `xero_token.id` and Xero organisation ID, not credentials.
- **Purchaser:** contact name/email, optional address and provenance. Organisation takes precedence; standard guest checkout uses the guest purchaser; otherwise an authenticated member is used. Complex checkout deliberately does not infer a guest purchaser from the first attendee.
- **Invoice intent:** `ACCREC`, currency, issue date, due date, status, PO reference, `Exclusive` line treatment and exact lines, including account, tax and tracking evidence.
- **Checkout context:** amount, currency, original payment method, PO number and PO-to-follow flag.
- **Stripe settlement, when applicable:** payment-intent ID, captured amount/currency, charge-derived payment date and configured clearing/bank account.

Issue date is captured at checkout; due date is 30 calendar days later, serialized as an ISO date. PO reference is the purchaser's PO or `TBC`; it is not the recovery identity. Standard lines retain the financial breakdown and attendee descriptions. Complex lines retain server-resolved ticket prices and quantities, with separate negative voucher/training-fund lines. The snapshot can therefore contain PII even though it contains no tokens or secrets.

**Important:** Missing explicit VAT evidence on any line, or an inconsistent gross total, requires review. We do not let Xero's current account tax defaults supply missing historical VAT. Discount/contribution lines without complete tax evidence also fail this check.

### Financial Validation

`validRecoverySnapshot()` requires a version-1 snapshot, a selected provider connection, a positive finite total, an uppercase three-letter currency, complete invoice/contact/date/line evidence and a maximum serialized size of 262,144 bytes. Invoice payloads must not already contain `InvoiceID`, `InvoiceNumber` or `Payments`.

```text
digits = currency's Intl.NumberFormat maximumFractionDigits
lineAmount = round(UnitAmount × Quantity × (1 − DiscountRate / 100), digits)
expectedTotal = round(sum(
  lineAmount + (LineAmountTypes == Exclusive ? TaxAmount : 0)
), digits)
require expectedTotal == snapshot.amount
```

Quantities must be positive; discounts must be finite and between 0% and 100%; tax type, tax amount and account code must be explicit. A supplied line amount must exactly match the computed amount. `NoTax` requires zero tax amounts. The current checkout producer captures `Exclusive`, although the validator also accepts `Inclusive` and `NoTax`.

The producer's `minor()` helper uses `Math.round(value * 100)` for gross/Stripe checks and tax freezing: **checkout capture currently assumes two-decimal minor units**, while worker line validation uses currency-specific precision. Do not assume automatic support for every three-letter currency.

Invoice/account bookings require no Stripe settlement and accept `DRAFT`, `SUBMITTED` or `AUTHORISED` invoice intent. Card bookings are normalized to `stripe` and require an `AUTHORISED` intent plus an exact succeeded settlement matching the invoice amount/currency.

### Stripe Evidence

The checkout paths retrieve the payment intent with `latest_charge` expanded. **`capturedEventSettlement()`** checks intent ID, succeeded state, event metadata, received amount, original amount, currency and the charge's succeeded/paid/captured state. Refunds, partially refunded charges, mismatched capture amounts or missing bank mapping require review. `paidAt` comes from `charge.created`, not payment-intent initiation time. Manual capture is rejected for review because charge creation alone does not establish its capture date.

This is evidence capture, not a second Stripe charge or refund. The recovery worker does not call Stripe.

### Exclusions and Review Cases

- Checkout skips `public_invoice_po`, `free` and nonpositive remaining balances.
- Disabled Xero invoicing, or active provider `none`/`quickbooks`, returns `not_applicable` without queueing.
- Automatic snapshots support only checkout `card`, `invoice` and `account`. Other methods require separate settlement review.
- Missing purchaser provenance, ambiguous/missing selected connection, incomplete VAT, invalid amounts or unsupported invoice status preserve review evidence; the producer saves the original invoice as `originalInvoice` and sets `invoice = null` to fail closed.
- An enqueue failure returns `needs_review`, `queued: false` and an explicit warning. It attempts to persist a mirrored booking review marker; it never claims that nonexistent durable work was queued.

Database eligibility independently requires a group reference, positive `ticket_price`/`total_amount`/`total_paid`, no existing Xero/generic accounting invoice, and a relevant payment method (`invoice`, `card`, `stripe`, `mixed`, `account`). It excludes cancelled/canceled/refunded/failed/pending-payment bookings. Invoice/account methods qualify directly; other eligible methods require paid state or a confirmed booking with a Stripe intent.

Enqueue checks the whole group: a `public_invoice_po`, free, cancelled/canceled or refunded row makes the operation `not_applicable`. Later guards recheck all group rows before provider work. Public invoice/PO registration is **not** converted into an Xero invoice by this worker, even if someone attempts a direct enqueue.

---

## Recovery Lifecycle

### States

| State | Meaning | Automatic claims? |
|-------|---------|-------------------|
| `pending` | Eligible immutable snapshot ready for work. | When due and connection available. |
| `processing` | Row and connection hold matching 120-second leases. | Only reclaimable after lease expiry. |
| `retry` | Transient failure retained with a future attempt time. | When due and outside connection cooldown. |
| `complete` | Valid invoice and, for Stripe, settlement evidence committed. | No. |
| `needs_review` | Missing evidence, conflicting identity or unsafe ambiguity. | No. |
| `not_applicable` | Excluded group/payment scope. | No. |

`event_invoice_recovery_mirror` updates both mirrored recovery fields on every matching source booking row. Completion links `xero_invoice_id` and `xero_invoice_number` across the group; it does not rewrite paid/confirmed state or repeat credit/capacity changes.

### Claim and Reconciliation

**`processEventInvoiceRecovery()`** is the sole recovery accounting processor:

1. Claim a due operation through `event_invoice_recovery_claim`.
2. Validate its immutable snapshot and current database guard.
3. Load the pinned Xero connection and current integration authorization.
4. Look up the exact invoice; for Stripe, also look up the exact payment.
5. Reject multiple matches, payment without invoice, or conflicting evidence.
6. If no invoice exists, persist invoice write intent before creating it. A durable invoice ID or previous invoice write intent forbids another create.
7. Validate every relevant remote financial field, then durably record the invoice ID before any payment write.
8. For Stripe, validate an existing exact settlement or persist payment write intent and create one. A paid/part-paid invoice without our exact settlement is not permission to pay again.
9. Recheck the guard and complete through the fenced finish RPC.

The claim uses `FOR UPDATE SKIP LOCKED` on connection and operation rows, choosing least-recently served tenants/connections and then oldest due work. Calls may optionally target a tenant/source/group, but still use the same leases. Neither checkout handler currently invokes this processor immediately; the scheduled runner is the checkout-to-accounting continuation.

### Retry and Connection Cooldown

Unknown errors and explicitly retryable provider/transport failures become `retry`. Known unsafe/nonretryable errors become `needs_review`.

```text
ordinaryRetryAt = now
  + min(3,600,000 ms, 60,000 ms × 2^min(attempts or 1, 6))
  + random jitter in [0, 30,000 ms)

rateLimitUntil = max(now, parsed Retry-After time)
  + 300,000 ms
  + random jitter in [0, 30,000 ms)
```

Attempts increment on claim, so the usual first retry is about two minutes plus jitter. Exponential delay caps at one hour; there is no automatic maximum-attempt cutoff. A `Retry-After` can be seconds or an HTTP date; absent/invalid values still impose at least five minutes plus jitter. **Long provider embargoes are never shortened by a cap.**

A 429 stops that attempt immediately and durably cools down the **whole pinned connection**, pushing other pending/retry rows on that connection forward. New pending rows inherit its cooldown. Other connections can continue. Only an explicit rate-limit rejection of the active invoice/payment write clears that write-start marker; an ambiguous timeout does not.

---

## Historical Sweep

**`event_invoice_recovery_sweep()`** discovers missing durable operations; it does not infer or create historical invoices.

For each of `booking` and `complex_event_booking`, it scans up to 100 source rows per scheduled run, ordered by UUID after the persisted cursor. It advances over ineligible and already-recorded rows too, preventing an immutable historical review group from starving later records. Reaching a short page resets that source cursor so future sweeps cycle through it again. The RPC accepts 1–500 rows per source; the scheduled caller supplies 100.

```text
for each bounded source page:
  if row is eligible
     and created_at is more than 10 minutes old
     and tenant/source/group has no operation:
    enqueue(snapshot = null, valid = false)
    -> normally needs_review / snapshot_unavailable
```

Group exclusions still apply during enqueue. The returned `swept` count counts discovered/enqueued groups, not invoices created. Terminal operations are not re-enqueued, and a reviewed historical row's null snapshot is not replaceable by a later enqueue.

**Important:** Legacy blank invoice fields alone never prove that an invoice is queued or safe to issue. Historical review is a finance/admin investigation, not automatic backfill from current event prices, tax settings or the first attendee's identity.

---

## Configuration and Settings

### Xero Enabled and Selected

`system_settings.xero_invoice_enabled` must be the string `'true'`. Missing values or anything else disable new checkout capture. The producer selects exactly one `xero_token` for the application tenant, with a real selected Xero organisation rather than `PENDING_SELECTION`. Zero or multiple connections require review rather than guessing.

Missing `tenant_accounting_settings`, including producer lookup error `42P01`, uses the legacy Xero path; an explicit `none` or `quickbooks` excludes new work. Any other unrecognized provider causes review. At processing time the adapter separately verifies current provider settings and refuses an explicit change away from Xero; provider settings query failures are retryable rather than silently ignored.

### Invoice Status and Account Mapping

The sales account is the event's trimmed `xero_account_code`, otherwise the tenant's `xero_sales_account_code`, otherwise `'200'`. Invoice intent status uses `xero_invoice_status` or `'DRAFT'`.

**Important:** The producer does not force paid-card invoices to `AUTHORISED`. The snapshot validator requires it for Stripe, so a `DRAFT`/`SUBMITTED` card intent becomes `needs_review`. Configure the intended status before eligible checkout; changing it afterward does not repair an immutable operation.

`xero_stripe_bank_account_code` has no automatic fallback in this producer. Payment creation validates exactly one active Xero account with the captured code, matching currency, and type `BANK` or `EnablePaymentsToAccount = true`.

### Existing Operations versus New Settings

Changing invoice-enable, nominal code, bank code or invoice status affects new capture, not existing evidence. Turning off `xero_invoice_enabled` alone is **not a worker kill switch**: the adapter checks current integration enablement/provider binding but does not reread that invoice-enable setting. Reconnection to a different token/organisation does not rebind queued operations automatically.

There is currently no dedicated recovery activation flag in the producer or cron. Use an operator-controlled schedule/invocation hold for rollout; if a separately reviewed activation flag is introduced, keep it off until the drain checks below pass and verify that it gates every writer invocation.

---

## Code Paths and Entry Points

### Standard Checkout

**File/function:** `api/functions/[functionName].js`, `createOneOffEventBooking`; invoked through the existing function-dispatch API.

1. Validate registration and Stripe evidence where relevant.
2. Complete required bookings, financial deductions, capacity and allocation invitation work.
3. For a positive non-public-invoice balance, call `enqueueCheckoutEventInvoice` with source `booking` and authoritative checkout values.
4. Continue optional notifications and return the booking result including `invoice_recovery`.

Accounting capture has one producer call and no competing raw Xero invoice/payment transport in this checkout path.

### Complex Checkout

**File/function:** `api/public/complex-event-booking.js`, default handler; triggered by public/member complex-event checkout.

1. Resolve server-side items/prices and validate payment.
2. Complete required booking, seat, financial and allocation work.
3. Enqueue source `complex_event_booking`, using the resolved items, remaining balance, unified currency and authenticated purchaser/organisation.
4. Continue confirmation notifications and return `invoice_recovery` with the confirmed registration.

An unauthenticated complex guest without purchaser evidence requires review; an attendee is not substituted as the booker.

### Scheduled or Authorized Manual Reconciliation

**File/function:** `api/cron/reconcile-event-invoices.js`, `eventRecoveryCronHandler`; calls `reconcileEventInvoices()` in `api/_lib/eventInvoiceRecovery.js`.

1. Accept GET or POST; other methods return 405.
2. Validate the exact `Authorization: Bearer <CRON_SECRET>` value; invalid/missing secret returns 401 before reconciliation.
3. Record the run start, sweep historical source rows, and process up to eight claims.
4. Stop claiming when the remaining wall-clock budget is under five seconds; mark success only after the bounded runner finishes.
5. Return 200 `{"ok":true}` or 503 with a generic unavailable error.

The internal runner returns counts for swept/complete/retry/review, but the endpoint does not expose these. A successful run means durable orchestration succeeded, **not** that every invoice completed; retained retry/review outcomes may coexist with HTTP 200.

### Public Health

**File/function:** `api/health/event-invoice-recovery.js`, `eventInvoiceRecoveryHealthHandler`.

1. Accept GET only; other methods return 405 `{"status":"method_not_allowed"}`.
2. Call only `event_invoice_recovery_health` through the server service client.
3. Return the allowlisted aggregate status with HTTP 200 or 503.
4. On database/migration failure or invalid response, return 503 `{"status":"unavailable"}`.

No caller credentials, Xero requests, token refresh, queue claims or writes are involved. Both cron and health set `Cache-Control: no-store`.

### Booking Reads and Invoice PDFs

`api/reports/event-registration-report.js` selects a linked group row first, then an attention/automatic-recovery row, and returns the mirrored fields in `groupPayment`. `api/complex-event-bookings/index.js` removes raw accounting/recovery error fields from member responses.

**`api/booking-invoice/[bookingGroupRef].js`** remains an authenticated read:

1. Require GET, configured database, session member and group reference.
2. Search tenant-scoped standard bookings, then complex bookings, for existing invoice linkage.
3. Require the same member or same organisation before provider access.
4. Prefer generic accounting linkage over legacy Xero linkage; use stored `accounting_provider`, or Xero for legacy `xero_invoice_id`, rather than following a later active-provider switch.
5. Fetch PDF and return inline when `inline=true`, otherwise attachment.

Missing linkage returns 404, not an attempt to issue an invoice. Authentication failures return 401/403; provider configuration failures return 503; other lookup/provider errors return 500. This PDF read can call the accounting provider, unlike the public health endpoint.

---

## Safeguards and Error Handling

### Fail-Closed Cron Authorization

The actual secret check has no URL/query or alternate-header fallback:

```javascript
if (!secret || typeof provided !== 'string') return false;
return expected.length === actual.length && timingSafeEqual(expected, actual);
```

An unset `CRON_SECRET` denies all runner requests. Never put the secret in a Better Stack URL, query string, screenshot or guide.

### Immutable Authority and One Settlement Owner

Enqueue returns an existing operation instead of updating its evidence. The immutable trigger rejects changes to tenant, source, group, snapshot, connection, Xero organisation and Stripe ownership:

```sql
CREATE UNIQUE INDEX event_invoice_recovery_settlement_owner
  ON public.event_invoice_recovery(tenant_id,settlement_payment_intent_id)
  WHERE settlement_payment_intent_id IS NOT NULL;
```

A competing group attempting to reuse the intent is retained as `needs_review` with `settlement_already_owned`; it does not become another settlement owner.

### Row and Connection Fencing

The guard requires a processing row, matching token and unexpired row/connection leases. It checks current booking cancellation/refund/payment-method/linkage state and Stripe intent binding. Each provider request calls the guard, not merely each invoice write.

```javascript
if (!await rpc('guard', { p_id: row.id, p_token: row.lease_token })) {
  throw new EventInvoiceRecoveryError('booking_or_lease_changed');
}
```

Stale finish tokens cannot commit a result. Lease loss before completion or retained error handling becomes an explicit persistence failure, not reported success. Guarding cannot retract a provider request already in flight; the sole-writer deployment drain remains necessary.

### Write Intent Before Transport

`start_write` accepts only a not-yet-started invoice write with no recorded invoice ID, or a not-yet-started payment write after recording an invoice ID. A missing exact remote result after a previous ambiguous write yields `invoice_creation_ambiguous` or `payment_creation_ambiguous` and review. We never depend on a provider idempotency-retention window to permit a second create.

Durable invoice ID outranks the visible invoice number. Missing/deleted known invoices and changed financial/contact evidence require review; they never authorize replacement invoices.

### Bounded Transport and Persistence

- Vercel function allowance: 60 seconds.
- Runner claim-loop deadline: at most 45 seconds; at most eight items.
- Per-item processing deadline: at most 35 seconds and never beyond the runner deadline.
- Provider transport: at most eight requests per adapter, including OAuth refresh; each request aborts after at most eight seconds or the remaining budget.
- Database RPC/read aborts: up to five seconds or the remaining deadline, where the query supports abort signals.
- Error retention receives an extra five-second persistence allowance.

These are bounds in the actual runner/transport, not a promise that eight invoices finish every tick. Start/sweep and final heartbeat use their own RPC allowances; no unbounded HTTP auto-retry helper is used.

### Provider Errors and Privacy

429 retains a retry plus connection cooldown. HTTP 5xx/408, ambiguous transport/JSON, lookup availability and explicit budget errors retry; validation/rejection, provider binding, evidence mismatch and unsafe identity/settlement cases require review. Stored `reason_code` is a short controlled code, not a raw Xero response.

Recovery tables have RLS enabled. `PUBLIC`, `anon` and `authenticated` cannot access them or call recovery RPCs. `service_role` has SELECT plus RPC execution, not direct queue-table INSERT/UPDATE/DELETE. The database owner is privileged, but that is **not** permission to bypass immutable evidence or grants during incident handling.

Public monitoring exposes only status. Member status widgets never render raw provider errors. The admin report still carries legacy `xeroInvoiceError` internally and converts it to a generic attention label; do not treat the entire report payload or protected snapshots as suitable monitoring data.

---

## Frontend UI

**`EventInvoiceStatus.jsx`** is a small inline badge with a keyboard-focusable tooltip; administrators may also see invoice number and next retry time. Members receive: “Your invoice is being prepared and will appear here when ready. No action is needed from you.” They do not see the underlying provider failure.

`eventInvoiceAwaited()` requires an applicable booking, no invoice ID and explicit `pending`, `processing`, `retry` or `needs_review`. Blank legacy linkage or an old error alone is not a queued state. Public invoice/PO, cancelled, free and fully voucher/training-funded records are excluded. Group selection checks all attendees, preferring invoice linkage on any row over attention or awaited status.

Once an invoice ID is linked, existing view/download controls are available even if a mirrored recovery state is still retrying settlement. Administrators can continue seeing `Needs attention` alongside an available invoice when settlement needs investigation. Automatic polling stops when no group remains awaited, on review-only groups, and after query errors; it does not poll Xero directly.

| UI/query | Recovery refresh |
|----------|------------------|
| Bookings: `['my-bookings', member id/email]`, `['my-complex-bookings', member id]` | 30-second refetch while invoices are accessible and a group awaits automatic work. |
| History: `['event-bookings', organisation/member id]`, `['history-complex-bookings', member id]` | Same access-gated 30-second refetch. |
| Registration report: `['event-registration-report', appliedFilters]` | 30-second refetch while returned group payments await automatic work. |

There is no recovery mutation, “retry now” button or snapshot editor in these pages. Worker changes appear through refetch, not client-side queue mutation/cache invalidation. Existing cancellation/transfer/report actions retain their own invalidations.

| Action | Endpoint | Method | Purpose |
|--------|----------|--------|---------|
| View invoice | `/api/booking-invoice/{group}?inline=true` | GET | Authorized PDF read. |
| Download invoice | `/api/booking-invoice/{group}` | GET | Authorized PDF attachment. |

The report's CSV/export status uses generic `Invoice awaited`, `Needs attention`, invoice label and optional ISO retry timestamp, never raw provider diagnostics.

---

## Database Tables

### `event_invoice_recovery`

Server-only authority for one event group's immutable evidence and mutable processing journal.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` | Generated operation primary key. |
| `tenant_id` | `uuid` | Application tenant; immutable. |
| `source` | `text` | `booking` or `complex_event_booking`; immutable. |
| `booking_group_reference` | `text` | 1–200 characters; immutable; unique with tenant/source. |
| `snapshot` | `jsonb` | Immutable versioned checkout evidence, or null for historical review. |
| `connection_id`, `xero_tenant_id` | `text` | Immutable provider binding captured from snapshot. |
| `status` | `text` | Constrained lifecycle state. |
| `next_attempt_at` | `timestamptz` | Due time for pending/retry; cleared on terminal finish. |
| `attempts` | `integer` | Default zero; increments per claim. |
| `lease_token` | `uuid` | Fencing token; cleared on finish. |
| `lease_expires_at` | `timestamptz` | 120-second row lease. |
| `invoice_id`, `invoice_number` | `text` | Durable remote invoice evidence; ID cannot be replaced by finish/record RPCs. |
| `payment_id` | `text` | Remote settlement evidence; required to complete Stripe work. |
| `settlement_payment_intent_id` | `text` | Immutable, uniquely owned Stripe intent per application tenant. |
| `invoice_write_started_at`, `payment_write_started_at` | `timestamptz` | Journaled pre-transport write intent; ambiguity barrier. |
| `reason_code` | `text` | Controlled failure/review code; finish validates at most 80 characters. |
| `created_at`, `updated_at` | `timestamptz` | Creation/update timestamps, default `now()`. |

### `event_invoice_recovery_connection`

Shared lease and provider embargo for a pinned connection; not a token store.

| Column | Type | Description |
|--------|------|-------------|
| `connection_id` | `text` | Primary key. |
| `tenant_id` | `uuid` | Application tenant owner. |
| `xero_tenant_id` | `text` | Selected Xero organisation. |
| `cooldown_until` | `timestamptz` | Connection-wide 429 embargo. |
| `last_claimed_at` | `timestamptz` | Fairness ordering timestamp. |
| `lease_token` | `uuid` | Must match processing operation token. |
| `lease_expires_at` | `timestamptz` | 120-second connection lease. |

### `event_invoice_recovery_monitor`

One global row holds sweep cursors and runner freshness.

| Column | Type | Description |
|--------|------|-------------|
| `singleton` | `boolean` | Primary key constrained to true; seeded by migration. |
| `last_started_at` | `timestamptz` | Set at authorized reconciliation start. |
| `last_success_at` | `timestamptz` | Set only after successful bounded sweep/processing orchestration. |
| `booking_cursor` | `uuid` | Standard source page cursor. |
| `complex_cursor` | `uuid` | Complex source page cursor. |

### `booking` and `complex_event_booking`

The migration adds exactly two columns to each existing source table:

| Column | Type | Description |
|--------|------|-------------|
| `invoice_recovery_status` | `text` | Nullable mirror with the same six allowed states. |
| `invoice_recovery_next_attempt_at` | `timestamptz` | Nullable due-time mirror. |

Existing fields used by recovery include `id`, `tenant_id`, `booking_group_reference`, `created_at`, `status`, `payment_method`, `payment_status`, `ticket_price`, `total_amount`/`total_paid`, `stripe_payment_intent_id`, `xero_invoice_id`, `xero_invoice_number` and `accounting_invoice_id`. Some optional financial/payment fields are read through `to_jsonb` for source compatibility. PDF/UI paths additionally use generic accounting provider/number and member/organisation ownership. Recovery does not define or replace the rest of these source schemas.

### Existing Settings and Connection Tables

These tables are dependencies, not new recovery-owned schemas; only the consumed fields are listed.

| Table | Columns consumed | Use |
|-------|------------------|-----|
| `system_settings` | `tenant_id`, `setting_key`, `setting_value` | Tenant invoice-enable, nominal code, status and clearing account settings. |
| `tenant_accounting_settings` | `tenant_id`, `active_provider` | Explicit provider selection or legacy fallback during capture. |
| `tenant_integrations` | `tenant_id`, `integration_type`, `is_enabled`, `credentials` | Current Xero enablement and OAuth client credentials. |
| `xero_token` | `id`, `app_tenant_id`, `tenant_id`, `access_token`, `refresh_token`, `expires_at` | Pinned connection lookup and fenced refresh-token persistence. |

---

## Data Flow Diagrams

### New Eligible Booking

```text
Checkout
  → Required booking/capacity/credit/allocation work succeeds
    → Capture immutable purchaser + invoice + payment evidence
      → Snapshot valid? ✓ → pending operation + booking mirrors
      → Snapshot unsafe? → needs_review + booking mirrors
    → Confirm booking; no checkout Xero write
      → Authorized scheduled runner claims valid due operation
        → Exact Xero invoice/payment lookup
          → Validate existing result OR journal first write and create
            → Record invoice evidence before Stripe settlement
              → Complete under matching guard
                → Link invoice across group → UI reveals PDF controls
```

### Ambiguous Provider Result

```text
Write-start marker committed
  → Xero write sent → response lost
    → retry retained
      → Later claim → exact lookup first
        → Exact valid result exists → adopt and complete
        → No exact result but previous write marker exists
          → needs_review; never another blind create
```

### Historical Discovery and Monitoring

```text
Five-minute scheduled run
  → Bounded cursor sweep
    → Eligible old group has no operation
      → null snapshot → needs_review, not automatic invoice
  → Bounded automatic claims
    → 429? → connection cooldown; other connections remain eligible
  → Successful orchestration heartbeat

Better Stack GET /api/health/event-invoice-recovery
  → Database-only freshness/backlog/lease checks
    → 200 healthy/waiting_provider OR 503 aggregate failure status
      → No Xero call, no purchaser data, no recovery write
```

---

## External Integrations

### Xero

The dedicated adapter sends frozen contact/invoice lines, dates, currency, account/tax/tracking mappings and purchaser PO reference. It uses `event-` plus the first 48 hex characters of SHA-256 over JSON `[tenantId, source, group]` as the provider-unique invoice number.

Before first linkage, invoice lookup is exact `InvoiceNumber == identity`; after linkage it fetches `Invoices/{invoice_id}`. The purchaser-editable invoice `Reference` is never used as the journal. Stripe payment lookup uses exact `Reference == identity + ":" + paymentIntentId`.

Invoice creation uses POST `Invoices` and idempotency key `{identity}-invoice`; payment creation uses PUT `Payments` and `{identity}-payment`. Invoice/payment responses are verified rather than trusted merely because HTTP succeeded. A Xero serialized `/Date(...)/`-style date is normalized to an ISO day for comparison; payment date uses the captured settlement day.

Access tokens expiring within 60 seconds are refreshed using the currently authorized tenant integration credentials. Encrypted credentials use `INTEGRATION_ENCRYPTION_KEY`, falling back to `SESSION_SECRET`; inability to decrypt requires reconnect/review. Refresh persistence matches application tenant, token ID, Xero organisation and the old refresh token; a failed compare-and-save is not treated as safe authorization to continue.

### Stripe

Existing checkout validation reads the succeeded payment intent and expanded charge. The worker consumes immutable evidence only and records the payment in Xero; it does not call Stripe, charge again or refund. This feature is not cancellation/refund or credit-note recovery.

### Vercel

`vercel.json` declares `/api/cron/reconcile-event-invoices` at `*/5 * * * *` (every five minutes, UTC) with a 60-second maximum duration. Vercel's cron GET must supply the configured bearer secret. A source schedule does not prove that the target deployment has activated it.

### Better Stack

Use an HTTP uptime check against the public health path, not a heartbeat URL and not the runner path. This feature does not send Better Stack heartbeats or require a `BETTERSTACK_*` variable. Existing heartbeat guidance for other jobs in `guides/better-stack-cron-heartbeats.md` is a different integration.

---

## Configuration Reference

| Setting | Location | Values / default | Description |
|---------|----------|------------------|-------------|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Server environment | Required for database client | Server-only service access; absent client fails closed. |
| `CRON_SECRET` | Vercel/server environment | Required, no permissive default | Exact bearer runner authorization. |
| `INTEGRATION_ENCRYPTION_KEY` / `SESSION_SECRET` | Server environment | Encryption key, then session fallback | Needed when stored OAuth credentials are encrypted. |
| `xero_invoice_enabled` | Tenant `system_settings`; Event Settings UI | String `'true'`; otherwise disabled | New checkout capture, not a worker kill switch. |
| `active_provider` | `tenant_accounting_settings` | Xero or legacy absent; `none`/`quickbooks` exclude capture | Worker refuses an explicit non-Xero binding. |
| `is_enabled` | Tenant Xero integration | Must be boolean true to process | Current integration authorization. |
| `xero_account_code` | Event | Nonblank event value wins | Captured sales nominal account override. |
| `xero_sales_account_code` | Tenant `system_settings` | Tenant value, otherwise `'200'` | Captured fallback sales nominal account. |
| `xero_invoice_status` | Tenant `system_settings` | Default `'DRAFT'` | Invoice/account accepts draft/submitted/authorised; Stripe requires authorised. |
| `xero_stripe_bank_account_code` | Tenant `system_settings` | No producer fallback | Captured Stripe clearing/bank mapping. |
| Selected Xero connection | `xero_token` | Exactly one selected connection at capture | Immutable connection/organisation binding. |
| Cron schedule / duration | `vercel.json` | Five minutes / 60 seconds | Deployment configuration, not tenant setting. |
| Runner limits | `reconcileEventInvoices` arguments/code | Eight items, 45-second loop deadline, 100 rows/source sweep | Bounded continuation; endpoint uses defaults. |
| Lease / health thresholds | Migration RPCs | 120 seconds; thresholds below | Database constants, not runtime environment options. |
| Recovery activation flag | Not currently implemented | None | Hold runner scheduling/invocations during rollout. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Test environment only | Optional browser executable | Offline browser suite; not application configuration. |

---

## Operational Setup and Rollout

### Pending Schema Setup

The migration **`202611300001_event_invoice_recovery.sql` is pending application until the main agent/deployment owner performs and verifies it**. Do not infer database readiness from the filename, local test success or presence of endpoints. This documentation task makes no schema, live-accounting, cron, secret or monitor changes.

Apply the migration through the approved Supabase migration process to the intended target. It is transactional but not a generally rerunnable SQL script: tables/functions/constraints are created without universal `IF NOT EXISTS` protection. Check migration history before attempting it twice. Existing booking tables and Supabase roles must already exist. Do not substitute a Drizzle push for this RPC/trigger/grant migration.

**Environment caution:** `api/_lib/database.js` does not provide an isolated development database mode. Preview and production use their configured `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`, and can point to the same database. A preview URL is not proof that invoking its runner is safe or non-production.

### Safe Deployment Order

1. **Hold recovery execution.** Keep the production event-recovery cron paused/not activated and block authorized manual runner invocation. Never use removal of the shared `CRON_SECRET` as a convenient per-job switch: other crons may share it. If a reviewed activation flag exists in the deployed revision, keep it off.
2. **Apply schema first.** Verify both mirrored booking columns, all three authority tables, seeded monitor, RPCs, immutable/mirror triggers, RLS and grants. Until this is done, recovery health should be unavailable and producer persistence can fail.
3. **Deploy the sole-writer code to every relevant entry point.** Standard and complex checkout must both enqueue rather than make their former raw Xero invoice/payment writes. Confirm there are no old checkout deployments or alternate traffic routes still writing for this booking scope.
4. **Drain old requests before cron activation.** A predeployment checkout already in flight can still issue a legacy Xero write even after traffic moves. Wait for all old request/background continuations to terminate, accounting for their actual maximum lifetimes. Inspect unresolved pre-cutover groups before treating them as safe recovery input. New worker leases cannot fence legacy code that never used them.
5. **Verify settings and authorization.** Configure the required service client, nonempty cron secret, enabled selected Xero integration, invoice status, explicit VAT evidence and correct Stripe clearing account. Do not manufacture missing evidence just to pass validation.
6. **Activate the runner only after the drain.** Ensure the five-minute schedule invokes the new deployment, not an old/preview route. Prefer a separately reviewed activation flag when available so deploying endpoints and enabling accounting work are distinct operations.
7. **Verify the first successful bounded run.** A database starting with no `last_success_at` is intentionally unhealthy even with an empty queue. An authorized runner success establishes freshness; it need not create an invoice. Do not send a writer request solely as a health probe.
8. **Enable the external HTTP monitor and review backlog.** Track aggregate health and protected counts/age of `needs_review` separately; historical review is not automatically drained.

**Rollback:** Hold the runner first and drain active processing before any code rollback. Do not restore a legacy checkout writer while recovery may still write. Preserve schema, snapshots, write markers and remote IDs; removing journal evidence or rolling back to competing writers is unsafe.

---

## Better Stack Monitoring

### Monitor Setup

Create a Better Stack HTTP uptime monitor for the **deployed application's `/api/health/event-invoice-recovery` path**, method **GET**, expecting **HTTP 200**. No login, bearer header, API key, cookies or query secret is required. Use the production application's real public host and ensure deployment protection does not redirect the monitor to a login page.

Recommended check interval is one minute, with an alert after two consecutive failed checks to reduce transient noise; these are operator recommendations, not application settings. The application already allows 15 minutes of cron freshness, so do not add a long external grace that masks a stopped five-minute schedule. Keep 503 `unavailable`/`never_succeeded` meaningful, rather than accepting them as setup-time success.

**Never configure Better Stack to hit `/api/cron/reconcile-event-invoices`.** That is an authenticated accounting writer, not a passive monitoring endpoint.

### Expected Statuses and Thresholds

The body contains only `{"status":"..."}`:

| HTTP | Status | Database meaning |
|------|--------|------------------|
| 200 | `healthy` | Recent successful run and no stale/backlogged/missing-authority conditions. |
| 200 | `waiting_provider` | Otherwise healthy, with pending/retry work on a connection whose cooldown is still future. |
| 503 | `never_succeeded` | No successful reconciliation recorded, even if no bookings need an invoice. |
| 503 | `stale` | Last successful run is more than 15 minutes old. |
| 503 | `stuck` | A processing lease expired more than five minutes ago. |
| 503 | `overdue` | Pending/retry work due more than 15 minutes ago outside active cooldown, or an eligible source booking older than 30 minutes has no operation. |
| 503 | `unavailable` | Database/RPC/schema unavailable, invalid health result or other endpoint failure. |
| 405 | `method_not_allowed` | Anything other than GET; use the configured method. |

Status priority is `never_succeeded` → `stale` → `stuck` → `overdue` → `waiting_provider` → `healthy`. Cooldown suppresses the overdue-due-row check for that connection, but does not excuse stale runner success, stuck work or missing operations. A 120-second lease becomes a stuck condition only when its expiry is more than five minutes behind database time.

The healthy boolean requires success **strictly newer than** 15 minutes; stale status uses **strictly older than** 15 minutes. At the exact timestamp boundary, a nominal `healthy`/`waiting_provider` status can therefore still return 503. Treat HTTP status as authoritative rather than accepting the text alone.

Health success measures sweep/runner freshness and automatic-work timeliness, not historical invoice correctness. **`needs_review` rows are not counted as unhealthy by this function**, so review backlog needs a separate protected operational process.

### Privacy and Diagnostics

Record status, HTTP result, latency and alert timing only in the public monitor. Do not attach raw snapshots, purchaser/attendee names, email/address, invoice/payment/intent IDs, group references, Xero response bodies, OAuth tokens or `CRON_SECRET` to monitor metadata or incident webhooks.

For authorized investigation, aggregate protected reads can show state counts without exposing evidence:

```sql
SELECT status, count(*) AS operations
FROM public.event_invoice_recovery
GROUP BY status
ORDER BY status;

SELECT last_started_at, last_success_at
FROM public.event_invoice_recovery_monitor
WHERE singleton;
```

These are read-only server/operator diagnostics, not grants for browser access and not publicly exposed health payloads. Restrict detailed evidence review to authorized staff and secure records.

---

## Safe Manual Review

There is no general review-resolution, force-retry, rebind or snapshot-edit endpoint in this implementation. A `needs_review` operation will not be automatically claimed and repeated enqueue will not repair it.

1. Identify the operation under authorized tenant/source/group scope and preserve its immutable evidence, remote IDs, write-start markers and reason code.
2. Establish the original purchaser, amount, currency, tax treatment, invoice date and, if relevant, exact captured settlement from trustworthy historical evidence. Today's event catalogue or first attendee is not a substitute.
3. Inspect the **pinned** Xero organisation read-only. Prefer the durable invoice ID; otherwise use the deterministic exact invoice number and exact settlement reference. Compare full financial/contact/payment evidence, not amount alone.
4. If an invoice/payment exists or might have succeeded, do not issue another one or record a second payment. A paid invoice without our exact payment evidence still requires investigation.
5. Escalate missing purchaser/VAT/capture-date evidence, deleted invoices, changed provider bindings and conflicting settlement ownership to finance and the deployment owner. Keep an auditable, access-controlled resolution record.
6. If a corrective invoice, credit or link repair is genuinely required, use a separately reviewed procedure that accounts for existing remote artifacts and active workers. The current guide does not grant a safe generic mutation procedure.

**Do not directly SQL-edit `snapshot`, provider binding or settlement owner; disable triggers; delete/reinsert the operation; clear write markers; change `needs_review` to `pending`; or invent historical evidence.** Table grants and immutable triggers intentionally prevent this. Even database-owner access must not be used to bypass the journal. Changing current settings can help future capture but cannot make an unsafe historic operation safe.

---

## Tests

The following are existing test entry points; they are validation instructions, **not a claim that this documentation task ran them or exercised live accounting**.

### Isolated Unit/API and UI Component Tests

```bash
node scripts/run-isolated-tests.mjs node --test \
  api/_lib/eventInvoiceProducer.test.mjs \
  api/_lib/eventInvoiceRecovery.test.mjs \
  shared/eventInvoiceRecoveryPresentation.test.mjs \
  api/complex-event-bookings/event-recovery.test.mjs \
  api/booking-invoice/event-recovery.test.mjs

node scripts/run-isolated-tests.mjs node --import tsx --test \
  client/src/components/booking/EventInvoiceStatus.test.jsx
```

Coverage includes snapshot fail-closed behavior, purchaser provenance, VAT/gross/Stripe capture evidence, exclusions, explicit enqueue failure, one producer/no competing checkout writer, exact lookup before writes, lost responses, paid-without-exact-settlement rejection, known invoice ID preference, idempotency-expiry ambiguity, 429 cooldown, provider changes, financial mapping/date comparisons, request/deadline budgets, mandatory cron secret, aggregate health and PDF authorization/provider pinning.

### Isolated PostgreSQL Migration/Concurrency Test

```bash
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  api/_lib/eventInvoiceRecovery.postgres.test.mjs
```

Requires local `initdb`, `pg_ctl`, `psql` on PATH and permission to create a temporary PostgreSQL cluster as a non-root user. The harness uses an allocated temporary directory and UNIX socket with TCP listening disabled; it creates its own roles/source fixtures and applies the migration there. It does not apply production schema or use a configured remote database.

Assertions cover denied public/authenticated access, denied direct service-role updates, immutability, duplicate enqueue, concurrent claims, expired lease fencing, mirrored status/linkage, connection cooldown/fairness, historical review, aggregate health, immutable Stripe ownership and concurrent settlement-owner collisions.

### Offline Browser Suite

```bash
npx playwright test --config=tests/event-invoice-recovery.config.mjs
```

Requires installed Playwright Chromium or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. The test bundles/mounts real Bookings, History and Registration Report pages with controlled fixtures; it starts no application server, blocks browser network escape and rejects unexpected writes. It checks standard/complex awaited status, neutral tooltip and no raw diagnostics, PDF visibility after linkage, administrator next-retry/review labels and excluded registrations. Screenshots go to the test output directory.

Do not replace these tests with live Stripe/Xero calls, production checkouts or writer-endpoint probing without separate authorization.

---

## Troubleshooting

### Problem: Health Is `unavailable`

**Symptom:** Public GET returns 503 `unavailable`.

**Cause:** Commonly the migration is still pending, the service database client is absent, an RPC is inaccessible, or persistence failed.

**Fix:** Confirm approved migration history, RPC/grant/schema presence and server service configuration. Do not suppress the error or switch the monitor to the writer endpoint.

### Problem: Health Is `never_succeeded` with an Empty Queue

**Symptom:** Schema exists but health remains 503 before any successful run.

**Cause:** Migration seeds the monitor with no success timestamp; absence of invoices is not evidence that the schedule runs.

**Fix:** Finish the sole-writer rollout/drain and verify an authorized bounded reconciliation succeeds. Do not fabricate or SQL-update `last_success_at` to make the monitor green.

### Problem: Cron Returns 401

**Symptom:** Scheduled/manual runner rejected before work.

**Cause:** `CRON_SECRET` is missing or bearer value is not an exact match.

**Fix:** Correct secure deployment configuration and authorized invocation. Query secrets, alternate headers and public monitoring credentials are not supported fallbacks.

### Problem: Health Is `stale`, `stuck` or `overdue`

**Symptom:** HTTP 503 despite an otherwise reachable application.

**Cause:** No recent successful orchestration, abandoned processing lease, delayed due work, or eligible old source groups lacking authority.

**Fix:** Check authorized schedule/deployment, persistence availability and protected aggregate queue/monitor state. Allow normal lease reclaim; investigate bounded throughput/backlog rather than clearing leases or creating invoices outside the processor. Historical missing-authority work should become review records, not auto-invoices.

### Problem: Health Is `waiting_provider`

**Symptom:** HTTP 200 while some invoice work is delayed.

**Cause:** A provider 429 established an unexpired connection-wide cooldown.

**Fix:** Respect the embargo and verify runner freshness. Do not clear cooldown or repeatedly call Xero; other connections can continue. Escalate persistent rate limiting through protected operations.

### Problem: Card Bookings Need Review

**Symptom:** Confirmed paid booking has `needs_review` rather than automatic recovery.

**Cause:** Possible draft invoice status, missing clearing account, incomplete VAT/gross evidence, manual capture, missing expanded charge, missing purchaser or conflicting Stripe owner.

**Fix:** Examine protected original evidence and controlled reason code. Correct settings for future checkouts and follow safe manual review for the immutable operation. Do not tell the purchaser to pay again.

### Problem: Legacy Invoice Never Appears Automatically

**Symptom:** Sweep creates `needs_review` with a null snapshot.

**Cause:** Historical discovery deliberately lacks trustworthy captured invoice intent.

**Fix:** Finance/admin historical review is required; neither repeated enqueue nor current prices/taxes repair the snapshot. This is not a failed automatic invoice backlog.

### Problem: Invoice Is Paid or a Write Timed Out, but Recovery Cannot Complete

**Symptom:** Settlement mismatch, creation ambiguity or evidence mismatch requires review.

**Cause:** An exact result cannot be established, or another payment/financial change conflicts with the snapshot.

**Fix:** Inspect the pinned organisation and durable IDs read-only, preserve write markers and prevent duplicate billing. Do not assume a timeout means no invoice/payment was created.

### Problem: UI Shows No Awaited Badge or PDF

**Symptom:** Blank legacy linkage has no recovery label, or download returns 404/403.

**Cause:** No explicit applicable recovery state, excluded payment/funding/cancellation scope, no linked invoice, or different member/organisation ownership.

**Fix:** Check the group-selected record and mirrored fields under the correct tenant. Missing linkage is not permission to create on download. Once legitimate linkage exists, PDF controls use stored provider selection; a current-provider switch does not rewrite historic linkage.

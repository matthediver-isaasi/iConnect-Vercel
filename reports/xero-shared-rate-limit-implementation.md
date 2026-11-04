# Shared Xero Accounting API rate coordination

## Release boundary

**Migration applied 4 November 2026 with explicit user approval.**
Applied the exact migration (SHA-256
`cc448da19b146e07ac02118621d9dc8ce429e953ad091fa8900804649df2fe0f`)
in one transaction to the pinned destination Supabase project
`lvmzliemqnieeoruhkik`, using verified TLS. Both tables were absent before
application; the accounting queue binding table was present. Verified RLS on
both new tables, RPC execution restricted to service_role, and no direct table
grants to anon, authenticated, service_role or PUBLIC. Committed and notified
PostgREST to reload its schema. No Xero requests, financial mutations or
application deployment were performed. The original implementation-only
boundary below describes the state before this approved migration.

This is a code and isolated-test implementation only. No live provider requests,
database migrations, credentials, tier changes, or configuration changes were made.
Before releasing this code, an approved operator must apply
`supabase/migrations/202612060002_xero_shared_rate_limits.sql` to the verified
destination database. Missing quota RPCs fail closed before sending requests.
Do not enable the code without the migration.

## Authority and limits

All application Accounting API transports use `xeroRateLimitedFetch`. Each request
resolves the saved bearer-token/organisation binding to the owning integration's
configured Client ID. A SHA-256 application key, not credentials, is persisted.
Missing, unowned or ambiguous bindings fail closed. Application identity is the
currently configured ID: the investigation's missing grant-time provenance remains
an explicit limitation; this implementation does not prove that credentials were
never changed since authorisation.

Service-only PostgreSQL RPCs serialize reservation/publication on the application
row. Rolling request history enforces 60 requests/minute and five in-flight requests
per application/organisation, and 10,000/minute across the application. Requests
have a 30-second abort bound and a 40-second lease; failed transports retain their
slot until lease expiry. Counters include unsuccessful attempts. There are no
automatic HTTP retries, sleeps, new financial writes, or changes to operation keys.

Responses retain Retry-After, day/minute/application-minute remaining headers and
X-Rate-Limit-Problem in service-only storage. Zero remaining triggers a pause even
on success. Day exhaustion without Retry-After conservatively pauses 24 hours,
not until midnight; minute exhaustion defaults to 60 seconds. Unknown 429 scope
pauses both application and connection. Numeric and HTTP-date Retry-After are
honoured without a daily/week cap; unrepresentably large delays fail closed to
infinity. A later success cannot shorten a pause.

Queue rows retain their existing write-intent, idempotency, discovery and retry
scheduling. New Xero embargoes are not copied to organisation-only queue bindings,
which would incorrectly pause independent applications. Pre-release legacy pauses
are still observed by the transport until expiry. QuickBooks handling is unchanged.

## Audited routes

- `api/_lib/xero.js`: default transports for contacts, tax, sales/membership
  invoices, payments, credits, PO edits and reconciliation reads.
- `api/functions/[functionName].js`: legacy direct Xero calls use the same boundary.
- `accountingRequestProviders.js`: queued preparation, writes, discovery, readback.
  Preparation consumers `accountingGoCardlessPreparation.js` and
  `quoteMembershipAccounting.js` already use this adapter's transport.
- `xeroCancellationRecovery.js`: uses shared reservations rather than an unfenced
  organisation-only cooldown update. Earlier writes still prevent safe replay.
- `eventInvoiceRecoveryXero.js`, `historicalInvoiceStatusRefresh.js`,
  `historicalInvoicePdf.js`, `stripePayoutContacts.js`, `pendingPoInvoice.js`,
  `memberMonthlyHistoricalPrices.js`, `memberAmendmentFinance.js`,
  `eventInvoiceAddressPolicy.js`, VAT sync and both pending-PO endpoints:
  default direct transports are coordinated.
- Membership invoice reconciliation reaches the shared gate through Xero helpers;
  its existing local pacing is supplemental, not quota authority.
- OAuth token exchange/refresh and `/connections` are not Accounting API calls and
  are deliberately not assigned organisation Accounting API quotas.

Injected transports remain available for tests and already-fenced adapter
composition. Do not inject raw HTTP into production Xero paths. Historical
one-off repair scripts are not application entrypoints and were not executed or
rewritten; a future operator must explicitly adopt the gate before reusing them.

## Verification

Run:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test scripts/xero-shared-rate-limits.postgres.test.mjs
node scripts/run-isolated-tests.mjs node --test api/_lib/accountingRequestProviders.test.mjs api/_lib/accountingRequestQueue.test.mjs api/_lib/eventInvoiceRecoveryXero.legacy.test.mjs api/_lib/memberCancellationRecovery.test.mjs api/_lib/memberCancellationProvider.test.mjs
```

The PostgreSQL fixture creates its own Unix-socket-only database and uses fake
HTTP. It exercises simultaneous queued-adapter/direct reservations, app/org and
app-wide budgets, independent applications, long daily/date/overflow pauses,
successful quota headers, persistence failures and service-role permissions.
Existing financial tests cover stable replay keys and successful POST followed
by failed readback remaining discovery-only. No live Xero or signed-in UI testing
is claimed.

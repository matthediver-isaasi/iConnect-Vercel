# Form product/bundle cart

## Deployment status

The cart migration is **prepared, not applied**. No destination schema checks,
production changes, provider-sandbox transactions or real transactions were
performed for this task. A successful build or local test does not establish
live capability.

The ordinary workspace preview currently reports `Tenant not found`. Browser
checks use the real application modules with intercepted tenant/form/payment
responses, not authenticated live tenant data.

## Contract and boundaries

- One top-level `sales_cart`, `cart_version: 1`, on standard forms; one existing
  Payment element whose `price_field_id` is the Cart ID.
- Separate product and bundle UUID allowlists, at most 100 items total.
- Answers contain version, item kind/ID and integer quantity (1–1000). Duplicate
  lines are combined and bounded. Prices and descriptive browser metadata have
  no authority.
- Ordinary product prices are catalogue net prices with line-rounded catalogue
  tax. Synced-code rate drift blocks checkout until the catalogue is refreshed.
  Bundles have no catalogue tax authority, so authors explicitly set each
  bundle's treatment and rate in Cart settings. Components never determine
  bundle tax or stock. No extra Payment-field tax is added.
- Active, date-eligible, same-currency tenant items only. Event ticket references
  and exhibition-space requirements on products or bundle components are
  excluded. Membership pricing, recurring payments, surveys, nested/repeated
  carts and legacy Bundle elements in the same form are rejected.
- Ordinary products default to unlimited; capacity metadata is not inventory.
  Product stock is independent of Sales proposals. Cart bundles use the same
  `form_bundle_stock` counters as legacy form bundle selections.
- Reservation and submission persistence share one database transaction.
  Quantities are reserved in deterministic item order; any failure rolls back
  all stock changes. Stock mode changes are blocked while holds exist.
- Receipt lines retain descriptions, quantities, net unit prices, tax
  treatments/rates, currency and totals. Accepted answers and payment terms
  cannot be edited. Receipts survive current catalogue/form edits in views and
  exports. Deletion/refund does not automatically restock.

## Payment recovery

The existing Stripe and GoCardless form payment flow remains the payment and
side-effect authority. Cart attempts recover frozen terms, never current
catalogue prices. Stripe uses a submission-scoped provider idempotency key;
concurrent publication losers must not cancel a shared provider intent.
GoCardless retains its existing submission-scoped keys and publishes the billing
request reference before hosted-flow creation.

Provider-confirmed paid transitions consume holds transactionally and
idempotently. The reconciliation worker releases only after verified terminal
cancellation. Browser cancellation, elapsed time, provider timeouts and missing
provider references are **not** release evidence. Such holds remain reserved
and acquire an administrator-review diagnostic. A retry without a recorded
Stripe reference is blocked after 23 hours to avoid provider idempotency-key
expiry. Do not manually release an uncertain hold or retry with a fresh key.

## Verification performed

- `node scripts/run-isolated-tests.mjs --allow-local-postgres node --test shared/formCart.test.mjs api/_lib/formCart.postgres.test.mjs api/_lib/formBundleStock.postgres.test.mjs`
  uses disposable Unix-socket PostgreSQL only. Covers last-unit concurrency,
  mixed rollback, legacy stock sharing, component independence, quantities,
  immutable terms, replay, cancellation/payment races, grants and tenant scope.
- `api/public/form-payment.cart.test.mjs`: mocked quote/create/retry, required
  answers, readiness, stock rejection before provider creation, provider
  timeout recovery, access restrictions, hidden carts and terminal cleanup.
- Mounted Cart/settings/stock tests cover configuration, mixed quantities,
  stale quotes, schema unavailability, retained answers, scoped locks,
  attempt restart and historical receipt exports.
- `npx playwright test --config=tests/form-cart.config.mjs`: public and embedded
  mixed checkout, required-answer handling, stock conflicts and provider return.
  Network/provider responses are fixtures; this is not a real payment test.

## Installation checklist — requires separate authorization

1. Verify the intended destination, catalogue column contracts and installed
   migrations. Do not use the workspace's legacy source as the destination.
2. Verify predecessors `202701200001_form_bundle_stock.sql` and
   `202701200002_form_bundle_submission_stock_option.sql`; preserve their
   existing/non-allocating receipt behavior.
3. Review and apply `202701200003_form_cart.sql` only with explicit approval.
   Reload the PostgREST schema. Verify `form_cart_version()` returns `1` as
   service_role, denies browser roles, and direct table mutation is denied.
   Verify reservation/immutability/paid-transition triggers and RPC grants.
4. Release matching application code separately. Missing capability blocks
   new cart configuration/checkout and product stock controls.
5. Confirm read-only catalogue readiness, allowed-item filtering and receipt
   display for the authorized tenant.
6. With separate sandbox authorization, exercise Stripe and GoCardless
   create/return/webhook/cron paths, interrupted provider creation, replay,
   embedded return and cancellation. Never use a real provider charge as a
   smoke test without explicit approval.
7. Verify reconciliation scheduling and review outstanding ambiguous holds
   before enabling public purchases. No automatic invoice, proposal, ticket,
   shipping or restocking workflow is introduced.

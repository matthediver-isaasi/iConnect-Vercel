# Form bundle selection and stock

## Behavior

Sales catalogue bundles have independent form stock. No stock configuration or
an explicit Unlimited value means unlimited availability. Finite quantities are
nonnegative integers. Available stock excludes reserved units; catalogue edits
use the editor's original version, so an intervening allocation causes a conflict.
Changing finite/Unlimited mode is blocked while holds exist.

Standard forms support one top-level, single-selection Bundle field with up to
100 tenant-owned allowed bundles. Nested/repeatable, survey, multiple bundle,
multiple payment and membership-pricing combinations are rejected. Bundle price
sources use the catalogue selling price and currency, not UUID-derived numbers
or supplied prices. Component prices/taxes and Sales/exhibition allocations are
not involved; existing payment tax semantics remain unchanged.

Unpaid submission insertion and allocation are one database transaction. Paid
insertion reserves before provider creation; authoritative paid status consumes
the hold in the same database transaction. Selection identity, payment amount,
currency and published provider reference cannot change after allocation. Accepted
bundle submissions cannot be deleted; retained evidence prevents accidental
restocking or a retry deduction. Bundle names are retained for detail/export.

The payment reconciliation cron checks aged holds. Age only authorizes requesting
provider cancellation; release requires confirmed terminal provider evidence.
Processing, missing-reference and ambiguous outcomes remain held, with an
administrator-review warning in the catalogue. No refund or restock is invented.
Stripe bundle creation uses one idempotency key per attempt; concurrent
publication losers must not cancel the winner's identical intent.
Same-key recovery verifies unchanged answers and the reserved bundle identity,
then uses the persisted checkout amount/currency and provider reference.
Subsequent catalogue price edits or archives do not re-price or block that
already-payable attempt. New attempts still use current catalogue terms.

## Migration evidence

### Per-element stock option (prepared, not applied)

`202701200002_form_bundle_submission_stock_option.sql` requires the base migration
below. The application gates the setting on a service-only schema capability:
before migration the checkbox is disabled with an explanation, disabled-setting
saves/acceptance fail explicitly, and legacy retries never read the absent receipt
table. Operational probe errors fail closed rather than pretending readiness.
Apply the migration **before enabling the option for authors**. Obtain its
offline hash with `node scripts/apply-form-bundle-stock.mjs --stock-option`.
Application requires explicit approval of the destination and deployment authority,
then the same runner with `--stock-option --apply --reviewed-sha256=<hash>
--confirm-destination=<approved-project>`. No live migration was applied for this
option. Read-only destination preflight on 2026-11-10 confirmed both base tables,
enabled insertion/settlement triggers and reservation/finalization functions;
the new selection-receipt table is absent. This confirms schema prerequisites,
not a deployed application or provider checkout. Recheck with
`node scripts/apply-form-bundle-stock.mjs --stock-option --preflight`.

The author setting `reduce_bundle_stock_on_submission` defaults true on new fields;
absence on an existing field means enabled. Only boolean false disables new stock
allocation. It does not bypass tenant, allowlist, eligibility, sold-out or price
checks. Disabled accepted selections retain a private immutable non-allocation
receipt so labels and original payment terms survive catalogue/configuration
changes. That receipt is not a hold and is never visited by hold cleanup.
Existing allocation settlement/cleanup is unchanged. No historical rows are
backfilled, reallocated or released. Manual entries now recompute hidden markers
and labels instead of trusting submitted markers.

Isolated PostgreSQL coverage includes disabled paid/unpaid acceptance, rollback,
invalid settings, finite and Unlimited modes, immutable original terms, denied
direct receipt writes, setting changes in both directions during checkout,
attempted retroactive allocation, duplicate insertion and final-unit contention.
Builder component/save-patch tests verify false/true round trips; browser fixtures
cover public, signed-in and iframe rendering for absent/true/false settings.
These are fixture checks, not customer submissions or live provider verification.
All nine browser cases passed (the first two initially exceeded the cold Vite
startup wait and passed on targeted rerun with a 30-second initial-render wait).
The focused suite passed 21 checks; the broader compatibility/payment suite
passed 216 checks. Workspace screenshot still shows the pre-existing
“Tenant not found” screen; signed-in live UI was not verified.

Completion validation exposed a pre-existing rolling-membership fixture issue:
equivalent PostgreSQL timestamps were compared as native Date versus FrozenDate
prototypes. The snapshot assertions now compare serialized values, retaining the
full value comparison without changing membership behavior.
After the readiness gate and fixture correction, all 28 focused checks and all
777 `rolling-memberships` checks passed.

`supabase/migrations/202701200001_form_bundle_stock.sql` was applied on
2026-11-06 to verified destination `lvmzliemqnieeoruhkik` using
`scripts/apply-form-bundle-stock.mjs`.

SHA256: `62a10142ef34e6401925746e319bf7199c9b11b7a2e8cb1bbecdd7425d9ddfc7`.

Service-only mutation grants and RLS were verified. SOURCE was not changed.
There was no historical stock backfill, customer data mutation, or deployment.

## Verification and limitations

- Disposable PostgreSQL tests cover last-unit contention, retries, transaction
  rollback, stale stock edits, immutable identity, successful unpaid insertion,
  price mismatch rollback, paid-update consumption, and expiry/payment races.
- Backend tests cover forged IDs/prices, tenant scoping, hidden answers,
  unavailable options, private form admission, invalid configurations,
  provider cancellation failures and stock-edit contracts.
- `api/public/form-payment.bundle-retry.test.mjs` exercises the actual create
  handler after a catalogue price change and archive. It verifies recovery of the
  original intent/amount without catalogue reads or another reservation.
- Frontend mounted tests cover stock controls, bundle options, quote
  invalidation and existing form/payment behavior.
- `npx playwright test --config=tests/form-bundles.config.mjs`: three passing
  public/authenticated/iframe browser fixtures with real app source. They verify
  sold-out disabling, authoritative displayed amount and answer preservation
  after an availability conflict. API/provider responses are fixtures.
- Existing form/payment regression coverage was run. Three unrelated tests in
  `api/public/form-payment.monthly-direct-debit.test.mjs` fail because their
  fixtures lack a required Direct Debit collection policy. Production membership
  policy behavior was not relaxed to make those stale fixtures pass.
- No real Stripe/GoCardless sandbox checkout, customer payment, signed-in
  production browser session, or deployment has been verified.
- Workspace preview uses legacy SOURCE and shows “Tenant not found”. The browser
  fixtures replace the HTML shell and network data, not application authentication.

## Focused commands

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/_lib/formBundleStock.postgres.test.mjs api/_lib/formBundles.test.mjs api/_lib/formBundleCleanup.test.mjs api/public/form-bundles.test.mjs
npx playwright test --config=tests/form-bundles.config.mjs
```

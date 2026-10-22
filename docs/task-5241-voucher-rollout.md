# Task 5241 — voucher extension rollout evidence

## Final integrated verification

Completion-review corrections: complex-event refunds now freeze per-attendee,
per-voucher integer shares from all original allocations, rather than trusting
the legacy first-voucher field. Disposable SQL regressions cover mixed owners,
£20.02 across three attendees, concurrent out-of-order cancellations and a
refund racing full compensation. Programme training-fund ledger entries now
use an explicit locked pre-debit snapshot; tests assert 20 → 0 for a 20 debit
and no second ledger row on replay. The rolling-fee regression's stale source
slice was updated to the guarded payment helper, with runtime ordering tests
for reservation, provider creation and identity persistence.

The combined isolated regression run passed **481 tests, 0 failures**, including
disposable PostgreSQL concurrency, all fourteen migrations installed together,
membership/card/DD/accounting fixtures, and the generic ownership boundary.
The management browser fixtures passed **5/5** after the final integration.
`npm run build` and `git diff --check` passed. The application workflow was
restarted; an unauthenticated `/admin/settings` screenshot showed the sign-in
screen, not the signed-in settings. Signed-in production UI and real provider
sandbox transactions are not claimed. Preview tenant-branding lookup errors
remain an environment limitation; the browser acceptance fixtures intercept
tenant APIs and do not use live identities.

DEST was inspected read-only with pinned identity and verified TLS. Existing
column contracts and capacity/allocation function definitions were checked;
all new schema applications occurred only in destroyed disposable databases.
The full ordered migration inventory/hashes are maintained in
`scripts/verify-voucher-credit-migrations.mjs` (offline by default, read-only
`--preflight`, no apply mode).

## Database rollout

No migration in this work was applied to a source, destination, production or
provider-sandbox database. No live financial writes or deployment occurred.
The booking integration tests applied the foundation and programme migrations
to a disposable local PostgreSQL database containing synthetic contract fixtures;
that database was stopped and removed after the tests. This is not destination
schema validation.

Apply only after destination identity and backup/rollback procedures are verified:

1. `supabase/migrations/202610200001_individual_voucher_credit.sql` — foundation
   ownership, service-owned credit lifecycle and administrative RPCs.
2. `supabase/migrations/202610200002_membership_voucher_quotes.sql`.
3. `supabase/migrations/202610200003_membership_voucher_settlement.sql`.
4. `supabase/migrations/202610200004_booking_voucher_refunds.sql`.
5. `supabase/migrations/202610200005_voucher_member_monthly_snapshot.sql` —
   nullable organisation owner, member owner, exact-one owner, tenant validation
   and member/month uniqueness. This replaces the earlier draft filename
   `20261003_voucher_member_monthly_snapshot.sql`.
6. `supabase/migrations/202610200006_program_voucher_purchase.sql` —
   service-only programme purchase completion, transaction ledger and credit
   allocation. Earlier draft programme filenames ending in `0002` and `0005`
   were not applied to a destination and have been replaced to avoid collisions.
7. `supabase/migrations/202610200007_booking_credit_attempts.sql` —
   fenced standard/complex voucher-funded booking attempts, atomic booking and
   internal-funding finalization, original-owner reversal and invoice continuation.

The sequence additionally requires `202610200010_membership_voucher_monthly.sql`,
`202610200011_membership_checkout_provider_attempts.sql`,
`202610200012_membership_voucher_accounting_binding.sql`,
`202610200013_membership_fee_requote.sql`, and
`202610200014_voucher_allocation_refunds.sql`.
All fourteen migrations still await approved destination application and
post-application validation. None were applied to SOURCE or DEST.

The snapshot migration does not rewrite existing closed organisation rows.
Deploy code and migrations together: owner-column queries and expiry RPC calls
require the migrated schema. Missing settings preserve organisation-only defaults.
The individual enablement flag controls issuance/redemption, not historical access.

## Isolated checks

The following tests run without database writes or provider calls:

```sh
node --test \
  api/cron/process-voucher-expiries.test.mjs \
  api/admin/voucher-members.test.mjs \
  client/src/lib/voucherSettingsForm.test.mjs \
  api/_lib/voucherMemberReporting.test.mjs \
  api/_lib/voucherMonthlyRollup.test.mjs
```

At the time of the implementation check: **25 passed, 0 failed**. Coverage includes
legacy organisation arithmetic, personal owner separation, award/allocation
deduplication, reservation/commit/release availability, original-value recovery,
member search tenant scoping and literal escaping, independent settings clearing,
and expiry RPC delegation/idempotency parameters. Changed JSX/server modules also
passed Babel parsing and `git diff --check`.

These unit checks are not deployed-schema, PostgreSQL concurrency or provider
tests. Foundation/integration test evidence must be reported separately by its owner.

### Isolated browser fixtures

```sh
npx playwright test --config=tests/voucher-management.task5241.config.mjs --reporter=line
```

**5 browser tests passed** against the already-running development preview.
Playwright intercepted every API request and aborted external requests. Synthetic
member/tenant/role/branding responses were provided only inside the test runner;
no application authentication bypass was added. All simulated writes remained
in fixture memory, with unexpected write routes rejected.

Assertions exercise real rendered settings controls and save payloads for
independent whitespace trimming/blank clearing; personal issuance with and
without an organisation, exact owner fields and stable-key presence; mixed-owner
balance/history labels; mounted tenant-intent changes refetching tenant-keyed
settings rather than displaying the previous tenant's cached names; and personal
history without an organisation while issuance is disabled, including fallback
terminology. The tenant switch is a fixture-driven invocation of the existing
active-tenant API, not a production tenant-switch/login journey.

These tests do not verify database authorization, RPC mutation/concurrency,
actual login, provider payments, real branding responses or production
signed-in UI. The existing preview was used without starting/restarting a
workflow. Production signed-in UI remains unverified.

### Booking and programme integration evidence

The booking implementer ran the following through
`scripts/run-isolated-tests.mjs` with outbound network access blocked:

- `api/_lib/bookingVoucherIntegration.test.mjs`
- `api/_lib/complexEventCreditQuote.test.mjs`
- `api/_lib/eventInvoiceProducer.test.mjs`
- `api/public/complex-event-payment-intent.credits.test.mjs`

Combined result: **61 passed, 0 failed**. These cover authenticated ownership
preflight, personal credit without organisation role authority, flag absent/off
organisation compatibility, tenant/foreign-owner rejection, configured names
with ownership in new invoice text, server-derived programme pricing, and
existing complex Stripe intent calculations using mocked provider calls.
They do not demonstrate complete checkout crash recovery.

`supabase/migrations/programVoucherPurchase.test.mjs` passes using the isolated
runner's `--allow-local-postgres` option. It applies migrations `0001` and `0006`
only to the disposable fixture database. Coverage includes legacy organisation
credit with the personal flag absent, programme purchase idempotency, exact
credit/training-fund/account/entitlement effects, grants, personal on/off
revalidation and transaction rollback. This does not prove compatibility with
the deployed schema or provider settlement.

The expiry cron intentionally returns HTTP 503 when its secret is unconfigured
and 401 when the supplied authorization is missing/wrong. The ordering suite's
old HTTP 500 expectation was updated to assert the explicit configuration error;
the authentication guard was not weakened. The isolated voucher ordering/cron
authentication suite then passed **10 tests, 0 failures**. The renamed `0006`
programme migration was also rerun successfully in the disposable SQL test.

The durable booking follow-up adds eight passing isolated tests in
`api/_lib/bookingCreditAttempt.test.mjs`: stable non-card identity, changed-payload
binding, cached retry, ambiguous post-commit response recovery, auth/key/test-mode
rejection, safe invoice snapshot fields and pending-invoice continuation.
It also checks that an expired execution fence is not treated as evidence to
refund a payment potentially owned by a newer attempt.
`supabase/migrations/bookingCreditAttempts.test.mjs` also passes against disposable
local PostgreSQL with migrations `0001` and `0007`. It exercises duplicate
finalization, concurrent retries, lease reclamation/stale-fence rejection,
capacity-failure rollback of bookings/vouchers/TF/discounts/seats, original-owner
compensation, grants, and personal complex booking without an organisation
including flag changes before finalization and after commitment. The fixture now
loads the actual capacity and allocation functions from their existing migrations.
It also rejects nonexistent stored account credit without side effects, and
commits legacy organisation vouchers with pending account/invoice remainders
while individual vouchers are disabled. Full deployed schema validation and live
capacity integration are not claimed by this test.

## Booking acceptance closure and verification boundaries

Earlier integration gaps were resolved as follows; live rollout remains separate:

1. **Closed in the voucher-funded standard/complex path by migration `0007`:**
   a stable authenticated purchase-request identity now covers card and non-card
   requests. A database fence serializes execution; changed request payloads are
   rejected, in-flight duplicates wait/retry, expired pre-commit attempts can be
   reclaimed, and committed retries return the original booking response.
   Booking inserts, seat/capacity checks, voucher reservation+commit, training
   fund effects, discount usage and allocation-invitation claim
   occur in one SQL transaction. Legacy non-voucher paths are unchanged.
   The destination has no stored organisation account balance. Checkout rejects
   `account_balance` explicitly and does not select/mutate that nonexistent
   column. Existing `account`, `invoice` and PO paths remain deferred invoice
   liabilities; they never populate a stored-credit debit. Organisation vouchers
   plus an invoiced remainder are covered with individual vouchers disabled.
2. **Closed for voucher-funded attempts:** training-fund and discount mutations
   no longer precede finalization. Definitive SQL failure rolls all of those
   effects back. Transport ambiguity is reconciled against the durable attempt
   instead of refunding a possibly committed purchase. The service-only reversal
   RPC restores original voucher/organisation provenance with a provider-outcome
   guard. Invoice input and applied labels are committed with the booking;
   retry and `/api/cron/recover-booking-credit-invoices` resume enqueueing through
   the existing accounting writer. Its five-minute cron is configured but has
   not been deployed. Confirmation email/Zoom side effects remain the existing
   post-booking mechanisms; they are not newly claimed to be exactly-once.
3. Migration `202610200008_program_member_entitlements.sql` adds service-owned
   personal programme balances for purchasers without organisations, retaining
   the existing organisation purchase RPC. Programme usage now derives quantity
   from booking rows and the programme tag from the tenant-scoped event; booking
   rows, entitlement debit and usage ledger are committed together. Usage
   cancellation atomically restores the recorded owner, marks the group
   cancelled, and records one reversal per booking. Personal balances remain
   separate after the member joins an organisation; registration offers an
   explicit personal/organisation owner selector validated by the server.
   Stable session-persisted programme registration attempts are bound to the
   authenticated purchaser and request, with an additional SQL request
   fingerprint and advisory lock preventing duplicate entitlement debits.
   Existing individual-booking cancellation paths restore the original owner
   atomically on the booking's cancelled status transition.
4. Programme purchase cancellation/refund was not previously offered and remains
   out of scope. Cancelling programme **usage** restores the ticket entitlement,
   not the credit funding used to purchase it. No new purchase-refund capability
   is introduced or claimed.
5. Programme invoice/accounting continuation now records gross invoices and
   separate funding payments, with persisted owner labels, explicit sales/tax/
   clearing mappings and a same-purchase accounting-only retry action.
   Missing mappings remain visible reconciliation errors, never cash-account
   fallbacks or silently discounted invoices.
6. Destination contracts were checked read-only and all fourteen migrations
   installed together in a disposable fixture. Signed-in production purchase UI
   and real card, Direct Debit, accounting-provider and live cancellation
   transactions were not exercised.

Do not deploy before the coordinated migration sequence and accounting mapping
configuration. Isolated tests do not establish provider-sandbox or live rollout
evidence.

### Personal programme entitlement implementation evidence

The member entitlement worker ran these in the isolated runner:

- `supabase/migrations/programMemberEntitlements.test.mjs` with
  `--allow-local-postgres`: **1 passed**, using disposable local PostgreSQL only.
  Covers no-organisation purchase/retry, real usage debit and booking creation,
  rollback on invalid booking, insufficient balance, foreign-member cancellation
  rejection, idempotent usage reversal to the original personal owner after an
  organisation move, organisation consumption compatibility, and service-only
  grants. Also covers explicit personal consumption after joining an organisation,
  SQL fingerprint mismatch rejection, sequential and two-connection concurrent
  retries producing one booking/debit, automatic individual cancellation,
  and individual-then-group cancellation without duplicate restoration.
  This fixture does not exercise voucher reservation; foundation credit
  integration evidence is separate.
- `api/_lib/programEntitlementBoundary.test.mjs`: **3 passed**. Covers scoped
  history reads, unauthenticated reads/non-admin ledger writes, no-organisation
  quote pricing and rejection of personal training-fund spending.
- `api/_lib/programRegistrationAttempt.test.mjs`: **3 passed**. Covers stable
  persisted client attempts, UI hydration not changing attempt identity, server
  owner/attendee binding, and booking-lookup restoration delegation. Combined
  entitlement checks: **7 passed**.
  The final combined run also reran `programVoucherPurchase.test.mjs` against
  the disposable fixture with programme accounting migration `0009` present:
  **8 passed, 0 failed**. No provider or destination writes were made.

Balances and programme purchasing load personal balances from an authenticated,
tenant-scoped function. Generic programme ledger reads now restrict non-admins
to their own personal owner or organisation; personal ledger writes cannot use
generic entity APIs. Standard programme registration/payment screens include
personal balances with an explicit owner selector even after joining an
organisation. Personal purchases require
card settlement for any remaining cash; no fictional personal account balance
is introduced.

Programme purchase cancellation/refund remains the preserved, out-of-scope
absence described above. Invoice/provider continuation is owned by the accounting
integration worker. Zoom registration now follows the successful entitlement
commit, and only the winning attempt performs it; completed/concurrent retries
return the original booking without repeating Zoom registration or confirmation
email. Existing Zoom already-registered handling remains. Post-commit crash
recovery for unperformed external Zoom/email work is not newly provided.
Signed-in UI, real provider payments and destination schema compatibility were
not verified. No deployment or live database mutation was performed.

## Presentation and historical integrity

Management, personal balances/history and monthly finance reports distinguish
organisation and individual ownership even when scheme names are identical.
Member names are tenant-resolved; missing names explicitly display “Name
unavailable”, not an unrelated organisation or a misleading UUID-as-name.
Exports and owner-summary rows carry the applicable scheme name without plural
suffixes. Portal menu destination defaults use configured scheme terminology;
existing authored menu labels are not mutated.

Monthly rollups preserve legacy organisation keys and use disjoint member keys.
Prior closed snapshots remain authoritative. Awards are represented once in
allocation movements; pending reservations affect availability rather than
liability. Expiry uses the service-only atomic operation instead of separate
ledger and balance writes.

## Integration checks still required before completion

### Membership checkout recovery additions (isolated, not deployed)

The membership implementation additionally requires, in order:

- `202610200010_membership_voucher_monthly.sql`: finite purchased-term funding,
  idempotent collection receipts, scheduled zero-cash instalments and verified
  pre-consent cancellation/release. Gross/credit penny remainders are apportioned
  explicitly while every provider cash instalment remains an integer minor unit.
- `202610200011_membership_checkout_provider_attempts.sql`: shared term claims
  and durable annual provider-attempt identity across token and authenticated
  member/organisation entry points.
- `202610200012_membership_voucher_accounting_binding.sql`: immutable accounting
  provider, connection, company and environment. Creation/payment requests carry
  the expected company context. A same-provider company reconnection cannot
  redirect a retry. An old uncertain attempt without a saved binding requires
  operator reconciliation rather than automatic adoption of today's company.
- `202610200013_membership_fee_requote.sql`: an explicit replacement-link flow.
  The original token and original history snapshot are retained in a service-only
  audit record; the predecessor link redirects to its replacement. Server-derived
  terms are saved before review/payment. Active payment attempts, paid/partial/
  unverified history and existing billing arrangements cannot be repriced.
- `202610200014_voucher_allocation_refunds.sql`: shared, service-only cumulative
  original-allocation refunds with ledger caps, duplicate protection and original
  personal/organisation ownership. Expired replacements require an explicitly
  approved future expiry, including when individual issuance has since been
  disabled; there is no automatic extension of an expired source voucher.

The fee page exposes **Create matching saved quote**, not a rejection-only
dead end for legacy organisation links or a different monthly sticker price.
An issued invoice retains its original gross/net liability: a replacement can
finance that debt over the offered finite count rather than reprice it. When
credit is needed to absorb the invoice's penny remainder, the page requires a
credit quote before provider setup and also offers an upfront replacement.
No currency conversion, accepted registration-term rewrite, or payment is
performed by quote regeneration.

Refund eligibility remains the existing finance-admin Direct Debit action.
Its confirmed cash-refund fraction restores the corresponding original voucher
allocations, with cumulative integer apportionment across mixed owners. A
submitted/created or failed refund does not restore credit. Where the provider
API omits refund status, signed lifecycle mirrors provide status and are checked
against the provider amount. Refund failure after a previously confirmed
restoration requires financial reconciliation; credit is not automatically
debited from its owner. The existing admin dialog supports explicit replacement
expiry and **credit-only reconciliation**, which never submits another cash
refund. Stopping a subscription/mandate under the existing cancellation policy
does **not** itself refund either owner's credit, and this disposition is audited.
No new Stripe membership-refund endpoint or new cancellation entitlement was
invented. Accounting credit notes/refund bookkeeping remain the existing
finance-refund workflow, not a newly automatic refund policy.

Voucher clearing mappings are in `AdminIntegrations.jsx`:
`xero_voucher_clearing_account_code` and
`quickbooks_voucher_clearing_account_id`. Missing mappings do not fall back to
cash accounts. Annual and per-instalment gross documents record voucher funding
separately from verified provider cash. Fully funded monthly purchases have no
synthetic provider payment: future documents are driven by durable zero-cash
instalment dates in the existing membership reconciliation cron.

Validation uses `scripts/run-isolated-tests.mjs --allow-local-postgres`, in-memory
provider/HTTP fixtures and disposable UNIX-socket PostgreSQL. The membership
test files are `membershipVoucherQuote.test.mjs`,
`membershipVoucherSettlement.test.mjs`,
`membershipVoucherSettlement.postgres.test.mjs`,
`membershipVoucherMonthly.test.mjs` and `membershipVoucherRecovery.test.mjs`
under `api/_lib/`, plus existing membership/card/DD/admin reconciliation suites.
Final combined membership run: **381 passed, 0 failed**, including all membership
migrations in disposable PostgreSQL, original-owner refunds with issuance
disabled, confirmed-refund replay, quote audit/replacement, fixed cash with
gross penny remainders, and accounting-company switch rejection. Changed JSX
parsed successfully; server syntax checks and `git diff --check` passed.
These checks are not live financial/provider-sandbox evidence. No live financial
calls are authorized or needed for this implementation review; signed-in UI and
approved destination rollout remain separate validation activities.

- Apply/validate migrations on the explicitly approved destination; verify
  exactly-one owner constraints and tenant foreign-owner rejection with SQL.
- Exercise administrative issuance retries, personal name resolution, mixed
  owner filters, exports and settings changes in an authenticated UI.
- Verify all purchase and membership integrations against their own task scope,
  including server quotes, provider minimums, monthly schedules, existing
  invoices, cancellation provenance and concurrent spending.
- Foundation reports the post-expiry restoration/re-expiry correction verified
  in its isolated tests. Repeat the lifecycle on the approved destination after
  migration; the browser fixtures do not exercise expiry RPC behavior.
- Reconcile an actual closed organisation month before and after migration,
  then a new mixed-owner month. No live historical finance cleanup is authorized.

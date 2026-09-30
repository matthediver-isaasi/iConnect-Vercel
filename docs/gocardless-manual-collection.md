# Finance-authorized single-period collection

## Boundary

`DirectDebitAdmin` offers **Run collection now** beside the existing dry run.
This is a collection-only action, not an all-stage membership runner. It shares
`runDynamicCollection`, reservation/provider effects, and the cron outcome
envelope. It does not invoke completion, notification, renewal or arrears jobs.

Finance authorization can bypass only next-check polling and the reviewed
processing-not-before time, using the real server and database clocks. The
server resolves price, identity, provider environment, mandate, collection
number and the actual installed financial due date. The client cannot supply them.
Its own service-only `gocardless_manual_collection_due_date` RPC uses the exact
original 20261108 anchor expression when that is the installed contract. If the
real amended helper exists, it uses it only with a consistent reviewed
reserve/attachment chain (including the exact plan-locking attachment wrapper).
Original cadence refuses any schedule version or amendment evidence. No stub
canonical helper or change-day migration is installed by this feature.
The confirmation fingerprint detects changed evidence; it is not a substitute
for server RBAC, tenant validation or database authorization.

Conservative limits:

- The intended due date must be in the current **Europe/London** calendar month,
  and no later than tomorrow. This is not a general arrears/backfill mechanism.
- One manual authorization per plan per London execution month, per due date,
  and per collection number. An unsuccessful or expired attempt consumes that
  authorization; do not delete/rewrite it to enable another click.
- An immutable service-only authorization records actor, reason, exact identity,
  intended period, amount/currency, provider date and canonical idempotency key.
  A new reservation must accept it within five minutes.
- Stopped/unreleased plans, lifecycle, owner pause, consent, immutable quotes,
  arrears, provider earliest date, permitted notice window and term bounds remain
  authoritative. This feature does not release Beta or other held cohorts.
- Reservation acceptance under the canonical plan lock is the financial
  linearization point. Revocation/expiry prevents **new** acceptance, not recovery
  of an already accepted payment. Neither rewrites original provider `checked_at`.
- An unconfirmed manual reservation is never automatically resubmitted, including
  by a cron worker whose earlier read lost the reservation race.

## Rollout status

The narrowly authorized production schema migration has been applied to DEST.
No authorization was issued, no collection/provider mutation was performed,
and no application/Vercel deployment was performed.

### DEST applied and verified — 30 September 2026

The initial broader-dependency version was stopped before apply because DEST
has the original cadence contract. Following explicit authorization for the
narrow alternative, the migration was revised to support that exact installed
contract without rolling out collection-day amendments.

Applied migration: `20261123_gocardless_manual_collection.sql`.
Reviewed/applied SHA-256:
`edc2a71473c90d6404d846f962ce6aa7aa799f4fab7cc0149599374f9dae738f`.

The pinned DEST runner used verified CA/hostname TLS, read-only preflight, a
short locked schema transaction with repeated contract checks, and a fresh
read-only postcommit verification. It checked 17 existing routine bodies and
23 reviewed financial trigger bindings, the new helper definitions/service
grants, audit RLS/immutability and absence of manual audit rows. The existing
five-table security/ACL/RLS-policy snapshot was unchanged.

Before/after row counts and complete-row digest snapshots were identical:

- All collection reservations: **0**.
- Cohort plans: **355**; cohort billing agreements: **355**.
- Cohort payment mirrors: **0**.
- New authorization rows: **0**; revocation rows: **0**.

The real change-day helper, amendment table and amendment RPC remain uninstalled.
No plan, agreement, mandate, configuration or cadence data was rewritten.
`NOTIFY pgrst, 'reload schema'` was committed for the new RPC schema cache.
No cron, campaign change or provider request was made.

Remaining: main-agent final source review and separately authorized application
deployment. Do not use a production collection as a rollout verification step.

### Future replay / rollout procedure

1. Review the complete diff and installed predecessor function definitions.
   The runner accepts only the complete reviewed original contract or the real
   reviewed amended contract, not mixed/partial sources. Current Pilot, Beta,
   Alpha and manual-cohort runtime guards must match. Original cadence cannot
   coexist with schedule amendment/version evidence. Do not work around source
   drift by removing guards or rewriting financial SQL ad hoc.
2. Run the offline preview:

   ```sh
   node scripts/apply-gocardless-manual-collection.mjs
   ```

   Independently review the displayed SHA-256 against
   `supabase/migrations/20261123_gocardless_manual_collection.sql`.
   A production operator may apply only after approval, using the existing
   pinned DEST connection and verified TLS runner:

   ```sh
   node scripts/apply-gocardless-manual-collection.mjs --apply --review-sha256=<approved-current-hash>
   ```

   Do not copy an old hash from a report after editing the migration.
3. Verify trigger bindings, SECURITY DEFINER/search paths, service-only RPC
   grants, RLS, audit immutability, original cohort hold protections, and absence
   of public/authenticated mutation access. Keep an installed-schema/function
   snapshot for review. This migration is additive and does not modify consent
   or release any plan.
4. The migration is already applied to DEST; deploy the API/UI only after the
   final source review. Other environments require the verified migration first.
   The runner refuses replay once manual audit rows exist: do not reapply during
   active use. Do not confirm a production charge as a deployment test.
5. Verify the UI using intercepted fixture responses or a separately approved
   sandbox tenant. A local `Tenant not found` screen is not browser verification.

## Ambiguous-outcome operator procedure — no provider re-POST

The UI's refresh buttons only refresh records. They **do not** perform recovery.
`blocked` or `uncertain` is not an invitation to retry. Public responses contain
safe codes/messages; detailed provider/database errors remain in restricted
server logs. New manual-attempt error text persisted on the plan is also safe
because the existing console can read that field.

If provider acceptance succeeded but local attachment failed:

1. Keep the manual authorization and reservation unchanged. Read the exact
   tenant-owned plan, agreement, authorization and reservation. Check immutable
   plan/agreement/owner/mandate/environment, due date, collection number, amount,
   currency, requested charge date and canonical idempotency key.
2. Use that tenant's GoCardless client in the recorded environment for **GET/list
   only**. If a provider payment ID was returned in the uncertain response, GET
   that ID. Otherwise locate payment evidence using the provider's retained
   metadata: exact `collection_reservation_id`, `plan_id`, and `tenant_id`.
   A mandate-scoped payment list is a lead, not proof of completeness. Paginate
   or inspect the provider dashboard as needed. An empty/limited list, matching
   name/date/amount, or an HTTP error does not prove no payment exists.
3. Require exactly one authoritative payment whose metadata and immutable
   reservation scope match. Check amount, currency, mandate, absence of a
   subscription, charge date, and any already-linked provider ID.
   The existing `assertDynamicPayment(reservation, payment, mandateId)` must
   succeed. Any missing, duplicate or conflicting evidence requires escalation;
   **do not create another payment, clear the reservation, change dates, expire
   a claim or rewrite the authorization**.
4. A separately authorized finance operator must explicitly approve **local
   attachment of that exact existing payment**, not another collection. Through
   the trusted server/service context, use the existing
   `resolveDynamicPayment(paymentId, { db, gc: tenantClient })` recovery helper.
   It GETs provider evidence and calls the canonical
   `attach_gocardless_dynamic_payment` RPC after validation; it does not call
   `createPayment`. Before invoking it, independently verify the exact
   tenant/reservation/payment linkage above; never accept arbitrary client IDs.
   There is intentionally no new self-service attachment button in this change.
5. Re-read payment mirror, reservation and plan. Confirm the exact provider ID,
   amount/currency/date/status and next **intended** collection period. Capture
   actor approval and before/after evidence in the existing incident/finance
   audit process. Do not claim completion/activation from mere attachment.

Expiration or revocation after reservation acceptance must not block this
validated attachment. If there is no provable existing provider payment, leave
the attempt blocked and seek a separately reviewed recovery decision.

## Verification and its limits

Use the isolation runner; these commands do not connect to production:

```sh
node scripts/run-isolated-tests.mjs node --test api/_lib/directDebitDynamicPipeline.test.mjs api/_lib/gocardlessDynamicCollections.test.mjs api/admin/gocardless-dd.collection.test.mjs
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test supabase/migrations/20261123_gocardless_manual_collection.test.mjs supabase/migrations/20261109_manage_monthly_collection_days.test.mjs
node scripts/run-isolated-tests.mjs node node_modules/tsx/dist/cli.mjs --test client/src/components/direct-debit/DirectDebitCollection.test.jsx
```

The disposable PostgreSQL test executes real canonical RPC bodies and the
current complete cohort runtime guard functions and financial-table trigger
bindings from migration source. Successful authorize/reserve/attach calls run
as `service_role` with RLS enabled and restricted table privileges. All four
cohorts, expiry attachment recovery, held Beta, concurrent identities, canonical
amended dates, revocation and immutable audits are exercised.
The disposable test alone substitutes its controlled clock for
`clock_timestamp()` to exercise the historical pre-midnight boundary. Neither
the migration applied by the runner nor the application contains that clock seam.

This is **not** a restored image of the destination's entire schema. Synthetic
fixtures represent already-adopted/released cohorts; import-manifest cardinality,
all unrelated tenant triggers, every historical migration/constraint and actual
installed destination grants are not attested by it. Separately inspect the
installed schema before approving rollout. No live money movement or successful
production/browser workflow is implied by these tests.
# Event Funnels: controlled activation

## Status — 26 November 2026

The original 45-file base release is already installed on DEST. **Never replay
it.** The owner-approved membership follow-up and controlled-activation migration
were installed atomically on verified DEST on 26 November 2026, after a successful
rollback-only rehearsal against its actual schema. **Never replay these either.**
Purchasing and both workers were enabled on 26 November 2026 after production
release/worker verification and the owner's explicit checkout-rehearsal waiver.
The authenticated sandbox checkout rehearsal was **not performed** and must not
be represented as a passed test. No real booking, payment, email, accounting or
Zoom operation was initiated by the operator during implementation/activation.

### Activation progress — 26 November 2026

The owner has requested go-live. The READY production deployment matches the
workspace release `1e06d6b14c72e6a7f85e1e4c6cc02759e04b4d65` and includes both
minute-by-minute funnel schedules. Both endpoints reject unauthenticated calls.
Production `CRON_SECRET` configuration was confirmed without exposing its value.

The rollout pins that deployed release with reader/worker versions `1`.
Initially both switches stayed false and `verification_evidence` stayed empty:
no authenticated checkout result was invented. The actual production schedules
reported matching heartbeats at `2026-11-26T21:04:38Z` (recovery) and
`2026-11-26T21:04:49Z` (reversals), while provider work remained disabled.
These timestamps are historical evidence, not a claim of continued health.

The existing browser checkout suite uses fixture APIs; it is not an authenticated
sandbox-provider checkout rehearsal. The only tenant named as a temporary test
tenant has no Stripe integration, while BNMS event payments are configured live.
Do not switch BNMS to test mode, treat that temporary tenant as an approved
sandbox, or claim the remaining rehearsal passed. The production membership
entitlement feature flag was not present in the environment configuration check;
membership-stage publication needs that separate setting as documented below.

### Live activation with recorded waiver

The owner selected **"Activate with recorded waiver"** after the missing rehearsal
and the risk to real purchases had been explained. The rollout evidence records
`checkoutRehearsalWaiver.status = "waived_not_tested"` with that exact approval,
its time and scope. The required legacy `authenticatedCheckout` evidence string
explicitly says **NOT PERFORMED** and points to the waiver; it does not claim
successful authentication, payment or cancellation testing.

- Recovery workers enabled at `2026-11-26T21:09:06.768Z`, purchasing still off.
- Both real production schedules reported again after enablement, at
  `21:09:38Z` and `21:09:49Z`.
- The READY production release was checked again before purchasing activation.
- Purchasing enabled at `2026-11-26T21:10:23.623Z`.
- An independent read-only SQL check confirmed `schemaReady=true`,
  `workersEnabled=true`, `workersHealthy=true`, `purchasing=true`, and no
  blocking reason. It confirmed zero funnel orders and zero published entries.
- No draft funnel was published, event payment mode changed, or synthetic
  purchase/provider test initiated. The separate membership-offer runtime flag
  was not enabled by this operation.

These are time-specific activation results, not a guarantee of future worker
health. Keep the purchasing-only backout below. Future production releases must
be checked and registered against the release-matching worker gate; otherwise
new schedules cannot refresh the old release's health and checkout pauses when
its heartbeats expire.

## Changes

- Publication now uses the saved, tenant-scoped definition and revision, validates
  its references again, creates server-owned commercial evidence, and invokes
  the existing transactional publication RPC. Client graphs, actors and prices
  cannot replace that evidence. Checkout still resolves purchaser-specific
  eligibility and prices again.
- The installed base, membership addition and activation controls are separate
  migration packages. Unknown follow-up releases fail closed.
- The Vercel recovery and reversal jobs run every minute **only after** their
  authenticated, production-only admission check. A disabled or unavailable
  gate never invokes provider handlers.
- Installation defaults both jobs and new purchasing to disabled. The rollout
  requires an explicitly reviewed application commit, compatible reader/worker
  versions and recorded authenticated-checkout evidence.
- Both scheduled workers must report that same commit within five minutes
  before new purchasing/publication is available. These heartbeats prove
  admission/reachability, not successful Stripe, Mailgun, accounting or Zoom
  delivery. Those providers retain their own reconciliation evidence.
- Pausing new purchasing does not disable recovery of existing purchases.
  Disabling workers is a separate operational decision.

## Installed schema additions

1. `202701270001_event_funnel_membership_entitlements.sql`
2. `202702040001_event_funnel_controlled_activation.sql`

Both were explicitly approved, compatibility-checked, rehearsed with rollback and
committed together. Do not replay them or their historical prerequisites.
The first adds private benefit/consumption/reservation records, history columns
and guarded membership triggers. The second adds private rollout controls and
worker heartbeats and replaces the draft-only readiness response. It does not
enable checkout or process any queue.

Offline packaging:

```sh
node scripts/package-event-funnel-migrations.mjs /tmp/funnel-membership-package --release=membership
node scripts/package-event-funnel-migrations.mjs /tmp/funnel-activation-package --release=activation
```

Never use the base installer to apply these additions. No automatic migration
step or generic source-directory push is permitted.

## Installation evidence

- Target: verified DEST `lvmzliemqnieeoruhkik`, reported `ACTIVE_HEALTHY`.
- Managed migration: `20261126113157_event_funnel_membership_and_controlled_activation`.
- Membership source SHA-256:
  `1541810f2960f77715dd5a88a9148a6a50d2d5871d79586577ac752c9a32ca4c`.
- Activation source SHA-256:
  `c08991c69902a05f74ef6af122f00fc58738d5fda8962ba62f4475f5055a2b1c`.
- Both exact source bodies executed in one guarded PostgreSQL DO statement.
  Outer source transactions were validated and removed; no historical base SQL
  was replayed. Advisory and short DDL locks bounded concurrent installation.
- Rehearsal reached the deliberate `FUNNEL_ADDITIONS_REHEARSAL_PASSED_ROLLED_BACK`
  exception only after all schema, grant and preservation assertions succeeded.
  An independent query confirmed the new tables/columns were absent, both
  modified function hashes were restored, and no rehearsal migration was recorded.
- The same statement, without the deliberate exception, then committed. Existing
  rows in both membership histories and the tracked funnel order, definition,
  session, hold, version and entry tables retained their row counts and MVCC
  fingerprints. Only the disabled singleton was seeded in the new tables.
- Post-commit: 36 funnel tables with RLS, no funnel RPC accessible to browser
  roles, two new history columns, and all 45 original base versions retained.
- Readiness: `schemaReady=true`, `activationVersion=1`, `authoring=true`,
  `purchasing=false`, `workersEnabled=false`, `workersHealthy=false`.
  Reader/worker versions were zero and no application release was marked verified
  at installation; the later activation progress above supersedes that state.
- Zero entitlements, consumptions, reservations, worker heartbeats, funnel orders
  or definitions. No customer/provider operations were run.
- Authenticated PostgREST discovery passed for readiness, membership readiness
  and an empty membership-list read. This did not invoke a recovery worker.
- Supabase's project metadata did not expose actual PITR recoverable timestamps.
  Recovery coverage remains owner-reported; no restore rehearsal was requested
  or performed, and none is claimed.

## Remaining deployment and activation sequence

The initial activation above is complete. This sequence remains the reference
for later releases; the recorded owner waiver applies to the initial rehearsal
and must not be silently reinterpreted as passing evidence for later changes.

1. The additions are installed and verified; keep both rollout switches false
   while completing the remaining deployment checks.
2. Deploy the matching application, publication path, booking readers and both
   scheduled workers. Confirm the actual production runtime exposes
   `VERCEL_ENV=production` and the intended `VERCEL_GIT_COMMIT_SHA`. A preview
   runtime is deliberately rejected, even if its Git commit matches. Do not
   assume promoting a preview changes its runtime environment.
   Verify the existing `EVENT_FUNNEL_MEMBERSHIP_ENTITLEMENTS_ENABLED=true` rollout
   setting in the matching production release before publishing membership
   stages. The publication endpoint refuses to advertise them while it is off.
   Both schedules must authenticate with the existing production `CRON_SECRET`;
   verify its presence without exposing its value or weakening authentication.
3. Perform an authenticated checkout/cancellation rehearsal using an isolated
   tenant and sandbox providers. Include ordinary booking regressions, reservation
   expiry, uncertain payment recovery, invoice access and optional membership
   acceptance/decline. Never substitute an unapproved real charge or email.
4. Record the reviewed production commit, reader/worker version `1`, and a
   reference to the authenticated rehearsal under
   `verification_evidence.authenticatedCheckout` in the service-only singleton
   `event_funnel_rollout`. Keep both switches false initially. No browser API
   exposes these controls.
5. Confirm both production schedules have reported that exact release in
   `event_funnel_worker_health`. Disabled schedules can report admission without
   processing provider queues.
6. After explicit activation approval, enable recovery workers, verify actual
   scheduling/admission, then enable new purchasing. Readiness must report
   `activationVersion: 1`, `schemaReady: true`, `workersEnabled: true`,
   `workersHealthy: true` and `purchasing: true`.
7. Publishing a saved funnel is a separate, authenticated administrator action.
   Activation alone must not create a published funnel or alter event visibility.

The owner waived a backup restore rehearsal. Do not reinstate that requirement
or claim it was completed. Recheck actual recoverable timestamps before a live
rollout; preserve operational backout and provider-reconciliation procedures.

## Operational backout

Set `purchasing_enabled=false` first: no new journeys/publication, but recovery
continues with its frozen purchase authority. Do not roll back application
readers or disable workers while unsettled orders/reversals require them.
Preserve all membership evidence after consumption; dropping its tables would
erase the explanation for a waived fee. A database restore does not undo an
external payment, email or provider registration.
Do not switch off the membership entitlement reader while existing benefits or
in-flight membership payments still depend on it; use the new-purchasing pause
instead and retain the matching simulation, cancellation and consumption readers.

## Verification

The isolated suite includes publication authorization, saved-revision conflicts,
server-owned pricing, schema/security, preview and stale-release rejection,
both worker schedules, heartbeat expiry, independent recovery during a purchase
pause, and real membership consumption/immutable non-payment evidence.
Disposable PostgreSQL applies both actual follow-up SQL files; it does not prove
production runtime deployment or successful external-provider operation.

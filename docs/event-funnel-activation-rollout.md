# Event Funnels: controlled activation

## Status — 26 November 2026

The original 45-file base release is already installed on DEST. **Never replay
it.** Purchasing remains disabled. The membership follow-up and the new
controlled-activation migration are prepared, not installed by this work.
Matching application deployment and an authenticated checkout rehearsal remain
separate release requirements. No real booking, payment, email, accounting or
Zoom operation was performed during implementation.

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

## Pending schema packages

1. `202701270001_event_funnel_membership_entitlements.sql`
2. `202702040001_event_funnel_controlled_activation.sql`

Both require an explicitly approved installation, live compatibility checks and
a rollback-only rehearsal on the actual installed baseline. Apply in order,
preferably in one transaction. Do not replay their historical prerequisites.
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

## Deployment and activation sequence

1. Install and verify the approved additions; confirm both rollout switches
   remain false and existing customer records are unchanged.
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

# Annual grace fallback workflow delivery

Only the annual non-recurring expiry sweep uses this contract. Monthly collection
arrears restriction/restoration is unchanged. Old completed expiry actions are
not backfilled.

The service-only `apply_annual_expiry_role` RPC locks the action and member,
compares the original role, validates the tenant fallback role and records the
full member before/after snapshots atomically with the role update. Matching
roles and lost comparisons do not create events. The existing sweep continues
to own renewal, pause, administrator and other-membership protections.

The live cron drains committed events independently of history completion,
traversal cursor, current member role and current membership eligibility.
It calls the existing member `field_change` dispatcher, system-initiated, with
a tenant-trusted URL and `annual-expiry-role:<tenant>:<action>` identity.
Simulation only has recording effects, not the live delivery capability.

Completed durable claims are acknowledged without invoking the dispatcher.
Processing/failed claims remain `review`; they are never automatically reclaimed.
Failures with no claim can retry because actions only start after claiming, and
the dispatcher releases a claim only on proven safe failure. A review or retry
increments the renewal report's errors without stopping unrelated events.
Review events are retained and reported on later sweeps. An operator must
reconcile actual effects before explicitly releasing any uncertain delivery.
No new replay/admin override endpoint is provided.

Versioned tenant discovery includes pending/review events even when no current
tier or unfinished history exists. Discovery also supplies outstanding event
counts, which are retained in continuation state and count toward `needs_review`
in worker health and per-tenant scheduled-task status. This also gates deferred
slices that do not reach the tenant. Only a completed delivery scan updates the
count, so interrupted scans cannot silently clear held deliveries.

## Read-only BNMS findings

Authoritative DEST inspection found:

- “Role Change - Former” is enabled, entity `member`, trigger `field_change`.
- Core `role_id` operator `equals` targets the “Former” role
  (`d536896d-b43a-4377-89ef-6c95f1496358`).
- It has no extra conditions, runs every time and does not require confirmation.
- All 17 inspected tier configurations enable fallback to that same role with
  90 grace days. This does not replace purchased snapshots or assigned historical
  expiry policies, which remain the enforcement authority.
- “Send membership payment” is disabled and targets a custom application field;
  “Set member login to active” is enabled but also targets a custom field. Neither
  matches this core role event. No workflow or renewal configuration was changed.

These are configuration observations, not evidence of production delivery.
Tests use synthetic records and injected action executors, never real recipients.

## Migration

`20261218_annual_expiry_role_events.sql` and
`20261219_annual_expiry_role_discovery.sql` are required before deploying this code.
The destination-only runner is `scripts/apply-annual-expiry-role-events.mjs`.
It adds transition/delivery columns and an index, restricts journal access to
service role, and installs the atomic RPC. It does not update live members.

Applied successfully to authoritative DEST (`lvmzliemqnieeoruhkik`), not SOURCE.
No migrations remain outstanding for this feature. Deployment is not performed.
The targeted expiry, delivery, owner-preview, renewal runner and disposable
PostgreSQL suites passed 115 tests, including recovery after tenant-state resets
and non-healthy review status on deferred invocations.

# Event funnel rollout preflight — 23 November 2026

**Implementation update, 26 November:** The unconditional application publishing
block has been replaced by a permission-checked, revision-safe publication path
and controlled activation/worker admission. The membership addition and new
activation controls are prepared but not installed. Purchasing remains off.
See [the activation rollout](event-funnel-activation-rollout.md) for current
requirements; statements below about the old code blocker describe the earlier
installation, not the updated application implementation.

## Status

The owner has authorised the complete migration rollout and selected full rollout
readiness rather than authoring-only installation. This supersedes the earlier
instruction to leave migrations unapplied, but does not establish that recovery
or activation is safe.

**All 45 migrations are now installed on verified DEST. Purchasing remains
disabled; the complete feature rollout is not yet activated.**

## Verified

- Read-only checks against documented DEST (`lvmzliemqnieeoruhkik`) found
  `event_funnel_definition`, `event_funnel_readiness()` and
  `event_funnel_consume_limit(uuid,text)` absent.
- The eleven inspected capacity/allocation routine definitions contain the
  expected initial patch anchors. This is a partial compatibility check, not
  execution of the complete migration chain.
- No funnel-named migration history entries were returned. History alone is
  not installation evidence: earlier project runners do not always record it.
- The full isolated API/domain/disposable PostgreSQL command passed 321 tests:

  ```sh
  node scripts/run-isolated-tests.mjs --allow-local-postgrest --allow-local-postgres \
    node --test --test-concurrency=1 api/_lib/eventFunnel*.test.mjs \
    shared/eventFunnel*.test.mjs scripts/event-funnel-recovery-readiness.test.mjs
  ```

- Offline packaging and existing recovery-gate tests passed eight tests:

  ```sh
  node --test scripts/event-funnel-deployment-manifest.test.mjs \
    scripts/event-funnel-recovery-readiness.test.mjs
  ```

- A collision-free deployment identity mapping is available for all 45 source
  files. The source SQL, hashes, order and historical names remain unchanged.
  The new deployment-version range had no entries in live migration history
  at inspection time. Recheck immediately before application.

## Outstanding — do not describe this as rollout-ready

- The owner reconfirmed two-minute PITR and explicitly waived a database restore
  rehearsal. No restore was run; this is owner-reported coverage, not independent
  verification of recoverable timestamps. Do not block on that waived rehearsal.
- Full live-schema-baseline rehearsal and partial backout remain unverified.
- The authoring API still rejects publication unconditionally. SQL readiness
  remains purchasing-disabled. Completing the activation implementation and
  its version/worker safeguards is separate from installing the 45 files.
- Recovery endpoints exist but their activation/scheduling remains unverified.
- No authenticated deployed journey, real payment, email, accounting, or Zoom
  operation was exercised.

The generated migration package is an offline preparation tool, not a live
installer. The original readiness gate remains fail-closed. Do not bypass it,
use a generic database push, claim the fixture tests establish live safety, or
enable purchasing merely to remove the current authoring error.

## Atomic installer preparation

`scripts/apply-event-funnel-release.mjs` adds an offline-default, SHA-pinned
DEST-only installer. Its explicit rehearsal mode rolls back the entire batch;
its apply mode commits only after all 45 files and service-only/RLS/readiness
checks succeed. Source outer transaction boundaries are validated and removed
so the batch uses one transaction, not 45 separately committed migrations.
Publishing remains disabled. Three installer tests passed.

The first attempted rollback-only rehearsal could not authenticate to the
destination PostgreSQL connection (SQLSTATE `28P01`). It failed before a
transaction or any migration started. No schema/history/data changes occurred.
The existing read-only MCP connection remains usable, but does not establish
that the direct installer credential is valid.

## Installed through the managed connection

After the owner updated/confirmed the direct connection secret, that connection
still returned `28P01`. The managed Supabase migration connection was used
instead; no credential was exposed or authentication weakened.

The exact 45-file package has combined SHA-256
`ea07ea80966f064028e6ad5aa0555b2953791ab558d8e2781bcf3f4439306527`.
The managed runner executes the entire chain inside one PostgreSQL DO statement.
Its rehearsal deliberately raises `FUNNEL_REHEARSAL_PASSED_ROLLED_BACK` only
after all DDL and checks succeed, rolling everything back. The expected exception
was observed; an independent query then confirmed the definition table was absent
and zero deployment versions were recorded.

The same package was then committed via the managed migration connection, with
the deliberate exception removed. Post-commit checks confirmed:

- All 45 deployment versions `20270123120001`–`20270123120045` recorded.
- Authoring ready; purchasing false; offer policy and legacy intent authority installed.
- Zero funnel tables without RLS; zero funnel functions executable by anonymous
  or authenticated API roles.
- Zero authored definitions (no test content or bookings created).
- PostgREST discovers readiness, authoring limit, definition save and publication
  RPCs after schema cache reload.
- Twelve installer/packaging/recovery tests passed.

This was a transactional migration rehearsal, not a backup restoration rehearsal.
No real payment, invoice, refund, email, Zoom operation or worker invocation was
performed. Direct pooler authentication remains unresolved but no longer blocks
this completed installation. Do not replay the source batch or the managed
installer: existing-schema guards intentionally reject repeat installation.

Remaining rollout work: implement/verify controlled application publication and
activation, verify compatible deployed readers and scheduled recovery workers,
and verify the authenticated journey. The SQL readiness function and application
publication blocker remain unchanged; this installation does not claim full
feature availability.

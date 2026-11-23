# Event funnel rollout preflight — 23 November 2026

## Status

The owner has authorised the complete migration rollout and selected full rollout
readiness rather than authoring-only installation. This supersedes the earlier
instruction to leave migrations unapplied, but does not establish that recovery
or activation is safe.

**No live migration or activation has been performed in this preflight.**

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

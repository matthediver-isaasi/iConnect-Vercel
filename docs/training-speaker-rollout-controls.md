# Speaker rollout controls — preparation only

This is a separate control release, not permission to install, deploy, pause or
apply the six agenda-speaker migrations. Those files must retain their approved
checksums. No historical awards, PDFs or missing speaker references are repaired.

## Installation and deployment gates

1. Obtain separate approval for
   `202701230001_training_speaker_rollout_control.sql`. It creates an initially
   **open** singleton, operation records, transition audit and write triggers.
   It neither installs agenda scope nor changes existing customer rows.
2. Install this control schema only against the verified target and deploy the
   control-compatible application to **every** production/preview caller using
   that database. Enable `SPEAKER_ROLLOUT_CONTROL_ENABLED=true` on those releases.
   Default/unset preserves current behavior but provides **no drain guarantee**.
   Do not enable before the control schema exists: enabled failures fail closed.
3. Independently verify actual serving revisions, flag enablement, old immutable
   deployment URLs, cron targets and manual/script callers. Retire or deny access
   to old callers. A new deployment or empty operation table is NOT evidence that
   all callers are covered. Record effective runtime limits and wait for old
   executions to terminate; inspect provider evidence for uncertain outcomes.
   Never send a test email or issue an award to prove readiness.

## Maintenance sequence (requires separate approval)

Only the database owner can execute `set_speaker_rollout_phase`. The application
service role can admit/finish operations and read status, but cannot change phase
or directly edit operation rows. Never expose phase control as a tenant API.

Read `speaker_rollout_control`, `speaker_rollout_operation` (especially rows with
`finished_at IS NULL`) and `speaker_rollout_transition` using the pinned operator
connection. Each transition requires the current generation and an evidence note.

- **open → draining**: rejects new instrumented operations; already admitted work
  may finish, including nested calls and final provider/audit writes. Whole cron
  execution, including the error-path recognition sweep, is tracked. Manual
  reconciliation, direct award/recognition/email/certificate entry points and
  Zoom speaker sync are also tracked. Unrelated crons continue.
- **draining → paused**: refuses while any operation is unfinished. It takes an
  exclusive gate-row lock, waiting for protected writer transactions. After it
  commits, affected event/agenda/session/speaker/award/recognition mutations fail
  with PT503. Thus editor writes can finish during draining, but cannot cross
  the completed pause boundary. Reads and unrelated event booking-counter updates
  remain available. New event creation/deletion and session edits are temporarily
  blocked, including ordinary events, because speaker processing shares these
  paths. Existing application surfaces may display their normal API error text.
- Capture fresh preflight counts/fingerprints **after pause**. Inspect provider
  leases, certificate attempts, error outcomes and old-version logs separately.
  Operation completion means execution ended, not business success or proof that
  every external effect succeeded. Existing helpers may return partial failures.
- Apply the six approved files by exact filename and order while paused. Verify
  historical evidence, privileges, indexes/triggers, policy cutoff and matching
  release. DDL is not blocked by the row-write triggers. Do not disable guards or
  introduce data repairs to make a migration pass.
- **paused → open** only after approved verification. Aborting from draining to
  open is supported; rolling code back while controls are enabled is not a safe
  substitute for a coordinated recovery.

## Unfinished and uncertain operations

No timeout expires an operation. A crashed process or failed completion write
leaves a durable blocker, deliberately. Do not clear it merely because its
timestamp is old. Establish that execution has terminated and reconcile provider
and database evidence before separately authorizing an audited resolution.
There is no automatic force-drain, replay or abandoned-row cleanup.

The SQL guard does not stop an old worker already sending an email or uploading
a private certificate. Caller coverage and actual external-flight drain remain
mandatory operator checks, not claims made by the control table.

## Local verification

Run through the isolated runner:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test --test-concurrency=1 api/_lib/speakerRolloutControl.test.mjs supabase/migrations/trainingSpeakerRolloutControl.test.mjs
```

Tests use mocks and a disposable UNIX-socket PostgreSQL instance only. They are
not evidence of a live pause, provider drain, deployment or installed schema.

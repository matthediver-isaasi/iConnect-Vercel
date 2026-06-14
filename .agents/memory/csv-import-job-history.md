---
name: csv_import_job history recording
description: Why import history silently never recorded, and the two code paths any csv_import_job write must cover.
---

# csv_import_job history recording

The `/importmanager` "Recent Imports" panel reads from the `csv_import_job` table, populated by `api/imports/execute.js`.

## The silent-failure trap
Job writes in execute.js are wrapped in try/catch that swallow errors. When the
INSERT/UPDATE referenced columns the table did not have, the writes failed
silently and the table stayed empty — no error surfaced anywhere.

**Why:** the table schema drifted from the code. Treat any swallowed Supabase
write against this table as suspect; column-name mismatches will not throw to the
user.

**How to apply:** when changing what gets recorded, confirm every column exists
in the live table (it is reachable from this workspace via the pooler /
`@supabase/supabase-js`), and prefer `.select()` + check `error` instead of a
bare try/catch.

## Two execution paths — both must record
`execute.js` has a SQL fast path (member import + `email` identifier + only
core/fast-path-safe fields) that returns early, and a JS path for everything
else. **Any history/recording logic must fire on BOTH paths**, or the most
common imports (the fast path) record nothing. Current design: create the job
row once before the branch, then finalize it in each path's success return plus
the outer catch (mark `failed`).

## Tenant isolation
`csv_import_job` is tenant-scoped via `tenant_id` (resolved from
`member.tenant_id` of the session member, same pattern as the import itself).
The jobs list endpoint must filter by `tenant_id` or it leaks cross-tenant
history.

## Status CHECK constraint must track the full lifecycle
The `csv_import_job.status` allowed values live ONLY as a CHECK constraint
(`csv_import_job_status_check`), not a pg enum. The original prod constraint
allowed just `pending/processing/completed/failed`. The background-import work
later started writing `initializing`, `queued`, `running`,
`completed_with_errors`, and `cancelled` — but the constraint was never widened,
so enqueue (inserting `initializing`/`queued`) failed in prod with
`violates check constraint "csv_import_job_status_check"`.

**Why:** new status literals were added across enqueue/process/execute/cron/jobs
code without a matching migration to the CHECK constraint.

**How to apply:** whenever you introduce a new csv_import_job status string in
code, widen the CHECK constraint in the same change (idempotent DROP IF EXISTS +
ADD). Current full set: pending, initializing, queued, running, processing,
completed, completed_with_errors, failed, cancelled.

## Background imports must self-drive without cron (Vercel preview)
The background import worker chain is started by enqueue's fire-and-forget kick
and kept alive by a worker->worker self-trigger; a Vercel cron
(run-import-jobs) is the only backstop that revives a stuck/queued job.

**Why:** Vercel runs scheduled crons ONLY on production deployments, never on
preview deployments. On preview, a job whose initial kick failed sits queued
forever (heartbeat/started_at null, cursor 0) — there is nothing to revive it.
This looked like "the import repeatedly attempts the same record" but was really
the foreground poll hammering a job that never started.

**How to apply:** don't rely on cron alone to start/revive import jobs. The
session-authed job-status endpoints (GET /api/imports/jobs and
/api/imports/jobs/[id]) nudge the worker when a job is queued or has a stale
heartbeat (see api/_lib/importWorkerDispatch.js). Any new "background job +
cron backstop" feature needs an equivalent foreground nudge to work on preview.

## Worker claim must guard terminal status, not just heartbeat
The worker's compare-and-swap claim in process.js originally matched only on
heartbeat (handoff) or queued/stale (kick). A cancel that lands in the
load->claim window (status read as processing, then flipped to cancelled, with
heartbeat unchanged) would be silently undone — the claim flipped cancelled
back to processing and the import resumed.

**Why:** cancel updates status (+completed_at) but NOT heartbeat, so a
heartbeat-only predicate still matched the row.

**How to apply:** every claim/continue UPDATE on csv_import_job must include a
non-terminal status guard (NOT IN completed/completed_with_errors/failed/
cancelled) in addition to its heartbeat/queued predicate. Also: any client-side
poll loop that watches for "done" must treat 'cancelled' as terminal or it
polls forever.

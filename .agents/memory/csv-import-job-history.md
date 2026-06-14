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

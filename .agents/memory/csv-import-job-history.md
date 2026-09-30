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

## PostgREST .or() does NOT work on an UPDATE/DELETE (only SELECT)
Calling `.or(...)` on a supabase-js `.update()` (PATCH) — e.g.
`.update({...}).eq('id',x).or('status.eq.queued,heartbeat_at.lt.Y')` — fails at
runtime with `column csv_import_job.status does not exist`, even though every
column exists and the IDENTICAL `.or()` works fine on a `.select()`. It is not a
column or schema-cache problem; PostgREST just can't compile an `or` filter into
a mutation's WHERE here. `.not('status','in','(...)')` is unrelated (works on
PATCH).

**Why:** PostgREST mutation queries qualify the column as `<table>.<col>` inside
the generated `or` predicate, which the UPDATE's statement can't resolve.

**How to apply:** never use `.or()` on a csv_import_job (or any) UPDATE. Express
an OR-of-conditions claim as SEQUENTIAL single-predicate atomic UPDATEs (try
`status='queued'`; else `status='processing' AND heartbeat IS NULL`; else
`status='processing' AND heartbeat < staleBefore`), stopping at the first that
updates a row. Each is its own compare-and-swap, so the exactly-one-claimer
guarantee is preserved, and pinning status to queued/processing per branch
inherently excludes terminal + 'initializing' (no separate guard needed). For a
genuinely atomic multi-condition claim, use a Postgres RPC instead.

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

## Server-to-server worker kicks DON'T work on Vercel preview
A background-job design that relies on a deployment calling its OWN functions
(enqueue's fire-and-forget kick, a worker->worker self-trigger, or even a
"nudge" fired from a status endpoint) silently does nothing on a Vercel PREVIEW
deployment: previews sit behind deployment protection, so the outbound
server-to-server call can't reach them, and Vercel runs scheduled crons ONLY on
production. A job whose kick failed then sits queued forever (heartbeat_at /
started_at null, cursor 0) — which presents as "the import keeps retrying the
same first record" but is really the foreground poll watching a job that never
started.

**Why:** only requests carrying the user's auth (the browser) get through a
protected preview; nothing server-originated does, and there's no cron backstop.

**How to apply:** drive the work from the authenticated BROWSER. The import
worker accepts a session caller whose member tenant matches the job's tenant and
treats it as `browserDriven`; the Import Manager poll loop POSTs to the worker
(one in-flight at a time) to run each slice. Crucially the browser must use the
SAFE non-handoff claim, NOT the exact-heartbeat handoff fast-path — see next
section.

## Never let the browser driver use the heartbeat "handoff" fast-path
The worker has two claim modes: a handoff claim that matches the EXACT current
heartbeat (used by trusted server self-trigger/cron continuations) and a
non-handoff claim that matches queued / released(null) / stale heartbeats. The
heartbeat is written only at slice START and END, never mid-slice, so during an
active slice the heartbeat is unchanged. If the browser driver were allowed to
use handoff, a browser kick fired while a server worker is mid-slice would match
that unchanged heartbeat and claim the SAME cursor window → two workers process
the same rows → inflated counts + duplicate insert-only note writes.

**Why:** "heartbeat unchanged" can't distinguish "worker actively processing"
from "slice finished, ready for next" — so exact-heartbeat matching from an
untrusted/uncoordinated caller is unsafe.

**How to apply:** force browser/session callers onto the non-handoff path
(`isHandoff = !browserDriven && handoff==='1'`). A browser-driven non-final
slice RELEASES its lease (writes `heartbeat_at=null`) and does NOT self-trigger,
so the next browser poll's non-handoff claim picks up the following slice
immediately without waiting out the staleness window. An active slice keeps a
fresh heartbeat and is never matched by the non-handoff predicate, and the claim
is one atomic conditional UPDATE, so a browser claim and a production
self-trigger/cron can coexist — the loser re-evaluates against the now-fresh row
and matches zero rows. The non-handoff predicate must also exclude
'initializing' (file not yet stored) by status, since released jobs and
'initializing' both have a null heartbeat.

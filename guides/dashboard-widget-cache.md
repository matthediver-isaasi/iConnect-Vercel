# Dashboard Widget Result Cache

**Author:** Replit Agent  
**Last Updated:** September 2026  
**Module:** Dashboard and Canvas widgets

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Cache Identity and Freshness](#cache-identity-and-freshness)
4. [Read and Refresh Behaviour](#read-and-refresh-behaviour)
5. [Scheduled Refresh and Fairness](#scheduled-refresh-and-fairness)
6. [Configuration and Operating Modes](#configuration-and-operating-modes)
7. [Code Paths and Entry Points](#code-paths-and-entry-points)
8. [Safeguards and Error Handling](#safeguards-and-error-handling)
9. [Frontend UI](#frontend-ui)
10. [Database Tables](#database-tables)
11. [Data Flow Diagrams](#data-flow-diagrams)
12. [Deployment and Database Target](#deployment-and-database-target)
13. [Configuration Reference](#configuration-reference)
14. [Diagnostics and Troubleshooting](#diagnostics-and-troubleshooting)

---

## Overview

Saved Dashboard and Canvas widgets use a durable PostgreSQL result cache. A
page view reads the latest successful result instead of rerunning every
aggregation. Results have a 15-minute freshness target, while a once-per-minute
Vercel cron processes due work in bounded slices. An authorized viewer can also
request one widget refresh from its card.

The core design principle is **authorization before cache access, durable work
coordination, and last-known-good data**. The API reloads and authorizes the
saved widget before touching cache state. PostgreSQL leases coalesce concurrent
work. A failed calculation records the failure separately and leaves the last
successful result intact.

This is a freshness target, not a guarantee. An outage, repeated calculation
failure, or backlog can leave a result overdue. The card therefore exposes its
last successful update and distinguishes current, stale, pending, and failed
states. Builder previews remain live; click-through drilldowns rerun the live
aggregation and can legitimately differ from the cached card.

---

## Architecture

### Key Files

| File | Purpose |
|------|---------|
| `api/dashboard/_lib/resultCache.js` | Cache response contract, claim execution, and bounded scheduler. |
| `api/dashboard/widgets/[id]/data.js` | Authorizes a saved widget and serves its durable result. |
| `api/dashboard/widgets/[id]/refresh.js` | Reuses the data handler with explicit-refresh semantics. |
| `api/cron/refresh-dashboard-widgets.js` | `CRON_SECRET`-protected scheduled worker entry point. |
| `api/dashboard/widgets/preview.js` | Runs unsaved builder previews live, outside this cache. |
| `api/dashboard/widgets/[id]/drilldown.js` | Runs click-through row discovery live, outside this cache. |
| `api/dashboard/_lib/permissions.js` | Dashboard actor, tenant, personal-owner, Canvas, and no-store boundaries. |
| `client/src/components/dashboard/WidgetCard.jsx` | Loads cached data, polls pending work, and renders refresh/status UI. |
| `client/src/components/dashboard/DashboardWidgetBuilder.jsx` | Supplies a tenant/member/role-scoped Dashboard query identity. |
| `client/src/components/canvas/blocks/dynamicBlocks.jsx` | Supplies a Canvas instance/auth-scoped card identity. |
| `migrations/dashboard_widget_result_cache.sql` | Service-only tables, trigger, fenced lease RPCs, and diagnostics. |
| `scripts/apply-dashboard-widget-result-cache.mjs` | Hash-reviewed, destination-pinned migration runner. |
| `migrations/dashboard_widget_refresh_receipts.sql` | Task 4727 additive forward upgrade for durable refresh receipts. |
| `scripts/apply-dashboard-widget-refresh-receipts.mjs` | Destination-pinned receipt upgrade runner with atomic payload-preservation verification. |
| `vercel.json` | Registers the every-minute refresh schedule. |
| `guides/better-stack-cron-heartbeats.md` | Records cron cadence and current monitoring coverage. |

### Design Principles

1. **Cache results, not authorization** — every read and refresh repeats normal widget access checks before cache RPCs.
2. **Keep the last success** — refresh errors update error/backoff state but never replace a good result with an empty chart.
3. **Fence publication** — a worker may publish only with its current widget identity, lease token, and unexpired lease.
4. **Coordinate in PostgreSQL** — claims, limits, fairness, and diagnostics are durable without Redis or an external queue.
5. **Bound scheduled work** — the cron uses two workers, a job cap, time budget, and database concurrency caps.
6. **Refresh active data** — all shared widgets are eligible, while personal widgets remain scheduled only for seven days after a view.
7. **Keep live-only paths explicit** — previews and drilldowns bypass historical cached results.
8. **Separate browser and server caching** — API responses remain `private, no-store`; only the service-side PostgreSQL result is reused.

---

## Cache Identity and Freshness

### Versioned Identity

`dashboard_widget_cache_identity` computes an MD5 digest of a JSONB array:

```text
[
  "widget-cache-v1",
  tenant_id,          // including null for single-tenant deployments
  widget_id,
  config,
  widget_type,
  scope,
  owner_member_id
]
```

JSONB provides deterministic object-key ordering. The widget type also selects
the aggregation option used by list widgets, so it belongs in the identity.
The scope and owner prevent a personal result from surviving a move to another
visibility or owner. The tenant and widget ID prevent reuse across tenants or
saved widgets, even when their configurations happen to match.

### Edit and Delete Invalidation

An `AFTER INSERT OR UPDATE` trigger synchronizes cache identity. If an update
does not change the identity, presentation-only fields such as title, size, and
display order retain the result. If any identity input changes, the trigger:

```text
clear result and successful timestamp
clear lease, request, error, and attempt state
reset failures
make the row due immediately
```

Deleting a widget cascades through the cache foreign key. An old worker still
cannot publish after an edit because its old identity and token no longer match.

### Freshness State

The successful publication time is **`updated_at`**. The service uses
`FRESHNESS_MS = 15 minutes` to classify the response. Successful publication
also sets **`due_at = now + 15 minutes`**.

| Status | Meaning | Data |
|--------|---------|------|
| `current` | A successful result is less than 15 minutes old. | Last successful payload. |
| `stale` | A successful result is at least 15 minutes old and no refresh error is recorded. | Last successful payload. |
| `pending` | No successful result exists yet and work is due, requested, or leased. | `null`. |
| `failed` | The most recent refresh attempt failed. | Last successful payload, or `null` if no attempt has succeeded. |

**Important:** `cache.pending` is separate from `cache.status`. A stale or
current result may remain visible while a refresh is leased or requested.

### API Contract

A successful data or refresh response is:

```json
{
  "widget": { "id": "…", "scope": "shared", "config": {} },
  "data": { "type": "group", "rows": [] },
  "cache": {
    "status": "current",
    "updatedAt": "2026-11-20T12:34:56.000Z",
    "pending": false,
    "error": null,
    "retryAfterSeconds": 900
  }
}
```

`retryAfterSeconds` is derived from the next due time, active lease, and
one-minute explicit-refresh cooldown. Clients clamp pending polling to between
one and 30 seconds.

---

## Read and Refresh Behaviour

### Warm Read

A warm request authorizes and touches the cache, updating
**`last_viewed_at`**. It returns the result immediately and never runs the
aggregation, even if stale. Due work remains durable for the scheduler.

### Cold Read

When there is no successful result, the request tries an atomic claim for this
exact widget identity. If it wins, it awaits one bounded calculation and reads
the row again. If another worker owns the lease or a global/tenant cap is full,
it returns `pending` with `data: null`; polling or the cron completes the work.

### Explicit Refresh

`POST /api/dashboard/widgets/:id/refresh` applies the same view authorization
as the data endpoint. It durably marks the selected result requested and due,
then tries the same atomic claim. It does not require edit permission: any
viewer who is allowed to view that saved widget may refresh it.

Two abuse controls apply:

- **Per-widget cooldown:** at most one explicit request is durably accepted per
  minute. A repeat during the minute returns the existing durable state rather
  than enqueueing another calculation.
- **Per-actor limit:** at most 20 explicit requests per tenant/member actor in
  a one-minute window. Exceeding it returns HTTP 429 with `Retry-After: 60`.

#### Correlated refresh protocol (task 4727)

Explicit responses include `cache.refresh = { outcome, requestId }`:
`accepted` records a new request, `queued` coalesces an existing request,
and `cooldown` declines new work with a null request ID. `success` or `failed`
is returned only when that same request has a fenced completion.
`cache.requestId` identifies outstanding explicit work. Every read exposes
`cache.completedRequestId` and `cache.completedRequestOutcome` so polling can
prove completion rather than treating a fresh timestamp or unrelated worker
as success. The row retains the most recent explicit completion, not an
unbounded receipt history.

`cache.pending` means an active lease or outstanding explicit request;
being overdue alone does not imply pending. A cold result still has status
`pending` when no successful data exists. Cooldown responses do not compute
warm results. Claims capture their request ID, so a request arriving after
an automatic claim remains queued for a later computation. Publication is
fenced by widget identity, lease token and unexpired lease. Edits invalidate
both results and receipt state; a failed refresh preserves last-known-good data.

### Failure and Backoff

An unsuccessful worker records a generic client-safe error while retaining any
successful payload. The next due time uses exponential backoff:

```text
delay_seconds = min(3600, 30 × 2^min(previous_failures, 7))
```

This yields 30 seconds, 60 seconds, 120 seconds, and so on, capped at one hour.
A failure retains the original lease exclusion until its 90-second expiry,
because a timed-out JavaScript request may leave downstream database work still
running after its promise rejects. A later success clears the failure count,
error, and lease.

---

## Scheduled Refresh and Fairness

Vercel invokes `/api/cron/refresh-dashboard-widgets` every minute. The handler
requires an exact `Authorization: Bearer <CRON_SECRET>` value and fails closed
when the secret is absent.

### Eligibility

- Shared widgets are always scheduler-eligible when due.
- Personal widgets are eligible only when **`last_viewed_at`** is within seven
  days. Viewing a dormant personal widget makes it active again and its cold
  path can claim immediately.
- A row must be due and have no unexpired lease.

### Claim Ordering

The claim function holds a short transaction advisory lock while enforcing
caps. It orders candidates as:

```text
least-recently-served tenant
  → rows overdue by more than one full freshness interval
    → explicit request before ordinary due work in the same overdue class
      → oldest due_at
        → widget_id tie-break
```

After a claim, the tenant's durable **`last_served_at`** advances. This
tenant-level rotation prevents one large tenant from indefinitely occupying
the front of the queue. The extra overdue class prevents a steady stream of
manual requests from starving results that have already missed the 15-minute
target.

### Bounds

| Bound | Value | Enforcement |
|-------|-------|-------------|
| Vercel cadence | Every minute | `vercel.json` |
| Scheduler wall-clock launch budget | 25 seconds | `runCacheScheduler` |
| Jobs attempted per invocation | 12 | `runCacheScheduler` |
| Application workers | 2 | `Promise.all` worker loops |
| Individual calculation timeout | 20 seconds | `executeClaim` |
| Database global active leases | 8 | Claim RPC |
| Database active leases per tenant | 2 | Claim RPC |
| Lease lifetime | 90 seconds | Claim RPC |

The 25-second budget prevents new jobs from launching after the boundary; an
already-started bounded calculation is awaited. Database caps coordinate
across overlapping requests and serverless instances, not just one process.

### Diagnostics

Every run logs a structured report containing:

- `attempted`
- `published`
- `failed`
- `durationMs`
- `backlog.eligible`
- `backlog.overdue`
- `backlog.failed`
- `backlog.leased`
- `backlog.oldestDueAt`
- `backlog.oldestSuccessfulUpdateAt`

The statistics RPC also prunes expired actor-limit rows and tenant scheduler
rows that no longer own any cache results.

---

## Configuration and Operating Modes

### Automatic Saved-Widget Mode

Dashboard and Canvas cards call the saved-widget data endpoint. Warm responses
come from PostgreSQL. Cold requests may calculate once; stale results return
immediately and wait for scheduled refresh.

### Manual Refresh Mode

The card's Refresh control calls the explicit endpoint for only that widget.
The last successful data remains visible while the request is pending or when
it fails. Polling stops when work settles, when the card unmounts, or when its
identity-scoped query changes.

### Live Preview Mode

The builder's `/api/dashboard/widgets/preview` route runs the aggregation
directly. Unsaved edits do not read or write saved cache state, so “Live
preview” remains accurate.

### Live Drilldown Mode

`/api/dashboard/widgets/:id/drilldown` reruns with row-ID collection enabled.
It does not cache row identities and must not be interpreted as the historical
record set behind the cached card. Source data can change between the cached
count and the click.

### CSV Export

CSV export uses the payload currently displayed in the card. It remains usable
offline from a refresh attempt, but it represents the shown cached snapshot,
not a forced live recomputation.

### Pre-Migration Behaviour

There is no silent fallback to direct aggregation if cache tables or RPCs are
missing. Saved-widget data responds with a generic HTTP 503 cache-unavailable
error. Apply and verify the migration before deploying cache-dependent API
code.

---

## Code Paths and Entry Points

### Saved Result Read

**File:** `api/dashboard/widgets/[id]/data.js`  
**Trigger:** Dashboard or Canvas card requests saved widget data.

1. Set `Cache-Control: private, no-store`.
2. Resolve the authenticated dashboard actor; resolution errors fail closed.
3. Require dashboard view permission.
4. Load the widget with tenant filtering.
5. Recheck exact tenant equality, valid scope, personal ownership, and Canvas
   shared-only policy.
6. Validate widget/config compatibility.
7. Call `readWidgetCache`, which touches activity and optionally services a
   cold claim.
8. Return the widget, result, and cache metadata.

### Explicit Widget Refresh

**File:** `api/dashboard/widgets/[id]/refresh.js`  
**Trigger:** An authorized viewer activates Refresh.

1. Accept POST only.
2. Reuse all data-route authorization.
3. Set `p_explicit = true` for the touch RPC.
4. Enforce actor and widget request limits atomically.
5. Try a claim and await it when capacity allows.
6. Return the selected widget's durable result/state.

### Scheduled Worker

**File:** `api/cron/refresh-dashboard-widgets.js`  
**Trigger:** Vercel cron every minute.

1. Set no-store.
2. Accept GET or POST.
3. Compare the bearer secret with a timing-safe exact comparison.
4. Run two bounded scheduler workers.
5. Fetch backlog statistics and log/return the report.
6. Return HTTP 503 with no internal detail when scheduling fails.

### Trigger Synchronization

**File:** `migrations/dashboard_widget_result_cache.sql`  
**Trigger:** Widget insert or identity-changing update.

1. Derive the versioned identity.
2. Upsert a cache row.
3. Preserve presentation-only updates or invalidate semantic changes.
4. Ensure the tenant has a fairness cursor.

---

## Safeguards and Error Handling

### Authorization Before Cache Access

The endpoint does not accept tenant, scope, or owner from the client. It loads
the saved row under `tenantFilter`, then explicitly checks it:

```js
if ((widget.tenant_id ?? null) !== (actor.tenantId ?? null)) return notFound();
if (widget.scope === "personal" && widget.owner_member_id !== actor.memberId) return notFound();
if (isCanvasDashboardEmbed(req) && !isSharedTenantWidget(widget, actor)) return notFound();
```

Missing or revoked access yields 401, 403, or 404 before a cache result is read.

### Snapshot Revalidation

The touch RPC receives the already-authorized widget snapshot, reloads and
locks the saved widget, and compares tenant, config, type, scope, and owner. A
race with an edit returns HTTP 409 rather than using stale authorization.

### Fenced Publication

Publication succeeds only when all fence conditions still match:

```sql
WHERE widget_id = p_widget_id
  AND identity = p_identity
  AND lease_token = p_token
  AND lease_until > now()
```

An expired worker, old configuration, deleted widget, or superseded claim
cannot overwrite the current result.

### Service-Only Storage

All cache tables have RLS enabled. `PUBLIC`, `anon`, and `authenticated` have
no table access or function execution. Only `service_role` receives access.
Every security-definer RPC pins `search_path = public`.

### Generic Errors

Aggregation details are logged server-side. Cache state stores and returns the
generic message “Unable to refresh widget. Please try again later.”, capped to
500 characters, so database/source details are not exposed.

### No-Store HTTP Responses

Dashboard and Canvas cache API responses set `private, no-store`. The Vercel
API-wide headers also disable HTTP caching. Durable PostgreSQL reuse must never
be confused with browser or CDN response caching.

---

## Frontend UI

**Primary file:** `client/src/components/dashboard/WidgetCard.jsx`

Each card displays its existing chart/stat/list, a Refresh icon button, and a
compact status region. The Refresh button has an accessible widget-specific
label, `aria-busy` while pending, and a spinning icon. The status uses
`role="status"` normally and `role="alert"` for failure.

### Status Presentation

| State | Presentation |
|-------|--------------|
| Current | Last successful “Updated …” time. |
| Pending | Refreshing state; existing data stays visible. |
| Stale | Warning that the shown data is out of date. |
| Failed | Alert with the safe error and existing data retained. |
| Success feedback | “Widget refreshed” confirmation for five seconds. |

### Mutations

| Action | Endpoint | Method | Purpose |
|--------|----------|--------|---------|
| Load/poll saved result | `/api/dashboard/widgets/:id/data` | POST | Read result and durable state. |
| Refresh one widget | `/api/dashboard/widgets/:id/refresh` | POST | Request/execute one authorized refresh. |
| Live drilldown | `/api/dashboard/widgets/:id/drilldown` | POST | Resolve current row IDs; bypass cache. |
| Live preview | `/api/dashboard/widgets/preview` | POST | Preview unsaved configuration; bypass cache. |

### Client Query Isolation and Cleanup

Dashboard card keys include tenant/member/role scope. Canvas keys separately
include Canvas mode, block instance, and auth scope. Canvas queries use
`gcTime: 0` and refetch on mount. On unmount or identity change, the card
aborts explicit refresh, cancels its exact query, and removes that result.

Pending polling uses `retryAfterSeconds`, clamped to one–30 seconds, and does
not run in the background. Explicit refresh updates only the selected card's
query data rather than invalidating every widget.

---

## Database Tables

### `dashboard_widget_result_cache`

One durable result and refresh-coordination row per saved widget.

| Column | Type | Description |
|--------|------|-------------|
| `widget_id` | `uuid` | Primary key and cascading FK to `dashboard_widget`. |
| `identity` | `text` | Versioned semantic identity fence. |
| `tenant_id` | `uuid` nullable | Tenant partition; null is a valid single-tenant partition. |
| `scope` | `text` | `shared` or `personal` snapshot. |
| `owner_member_id` | `uuid` nullable | Personal-owner snapshot. |
| `result` | `jsonb` nullable | Last successful aggregation payload. |
| `updated_at` | `timestamptz` nullable | Last successful publication time. |
| `last_viewed_at` | `timestamptz` nullable | Last authorized card read. |
| `due_at` | `timestamptz` | Next eligible attempt time. |
| `requested_at` | `timestamptz` nullable | Durable explicit-request priority marker. |
| `request_id` | `uuid` nullable | Outstanding explicit refresh receipt. |
| `lease_request_id` | `uuid` nullable | Receipt captured by the active claim; newer requests cannot be acknowledged by older computations. |
| `completed_request_id` | `uuid` nullable | Latest fenced explicit completion receipt. |
| `completed_request_outcome` | `text` nullable | `success` or `failed` for that completed receipt. |
| `last_explicit_at` | `timestamptz` nullable | Per-widget cooldown timestamp. |
| `lease_token` | `uuid` nullable | Random publication fence for the current worker. |
| `lease_until` | `timestamptz` nullable | Lease expiry/recovery boundary. |
| `last_attempt_at` | `timestamptz` nullable | Most recent claim time. |
| `failures` | `integer` | Consecutive failure count used for backoff. |
| `error` | `text` nullable | Generic most-recent refresh error. |

### `dashboard_widget_cache_tenants`

Durable least-recently-served cursor for tenant-fair claims.

| Column | Type | Description |
|--------|------|-------------|
| `tenant_key` | `text` | Tenant UUID text or literal `null`; primary key. |
| `last_served_at` | `timestamptz` | Last time the scheduler claimed this tenant. |

### `dashboard_widget_refresh_limits`

Short-lived actor request counters.

| Column | Type | Description |
|--------|------|-------------|
| `actor_key` | `text` | Tenant/member compound key; primary key. |
| `window_start` | `timestamptz` | Start of the current one-minute window. |
| `requests` | `integer` | Requests observed in the current window. |

---

## Data Flow Diagrams

### Warm or Stale Card

```text
Card requests saved widget
  → Server authenticates and authorizes current actor
    → Touch cache and record last_viewed_at
      → Successful result exists
        → Return it immediately with current/stale metadata
          → If due, cron claims it later
```

### Cold Card with Concurrent Requests

```text
Several cards request the same cold widget
  → Every request independently authorizes
    → Atomic claim allows one identity/token owner
      → Owner computes and publishes
      → Other requests receive pending/null
        → Poll reads the eventual successful result
```

### Failed Refresh

```text
Authorized viewer requests Refresh
  → Durable request and lease
    → Aggregation fails
      → Preserve previous result
      → Record generic error and exponential due_at
        → Card shows failed state plus previous data
          → Scheduler retries after backoff
```

### Edit During Computation

```text
Worker holds identity A and lease token A
  → Widget semantic configuration changes
    → Trigger writes identity B and clears lease/result
      → Old worker tries identity/token A publication
        → Fence updates zero rows
          → Edited widget remains cold and due under identity B
```

---

## Deployment and Database Target

### Required Order

1. Review `migrations/dashboard_widget_result_cache.sql`.
2. Run the migration runner without flags to obtain its exact SHA-256.
3. Approve that exact SQL and hash.
4. Apply to the pinned **DEST** project.
5. Verify the runner reports all three tables, six functions, trigger, and
   backfill as valid.
6. Deploy the API/UI and the Vercel cron registration.
7. Observe natural scheduled runs and the backlog before calling rollout
   healthy.

### Safe Runner Commands

For existing installations, task 4727 uses the narrow forward migration,
not a replay or edit of task 610's historical migration:

```bash
node scripts/apply-dashboard-widget-refresh-receipts.mjs
node scripts/apply-dashboard-widget-refresh-receipts.mjs \
  --apply --review-sha256=<reviewed-sha256>
```

The forward runner uses the same DEST-only pins and verified provider CA.
Within one transaction it verifies four columns and four restricted
security-definer functions, and compares existing cache payloads, identities,
timestamps, failures and leases before/after the upgrade. Apply this database
upgrade before releasing the new refresh API protocol.

Offline review performs no database connection or write:

```bash
node scripts/apply-dashboard-widget-result-cache.mjs
```

After review, apply only with the hash printed by that exact invocation:

```bash
node scripts/apply-dashboard-widget-result-cache.mjs \
  --apply \
  --review-sha256=<reviewed-sha256>
```

The runner requires both `DEST_SUPABASE_URL` and `DEST_DATABASE_URL`, pins the
REST project to **`lvmzliemqnieeoruhkik`**, pins the approved direct/pooler SQL
hosts, database, port, and user, strips connection-string TLS overrides, and
uses Supabase's CA with certificate and hostname verification. It never falls
back to `SUPABASE_URL`, `DATABASE_URL`, or SOURCE.

The migration carries `BEGIN`/`COMMIT` for safe manual review. The runner
verifies that exact single wrapper, executes its body inside the runner's own
transaction, performs post-apply authorization/integrity checks, and commits
only after they pass.

**Deployment status (task #610):** the reviewed migration was successfully
applied with SHA-256
`9423651ed7e8d143fae08f9aa53f90d02fa1f2b1fdea3ac4d7945ac4ad322a5c`
to pinned, verified-TLS DEST project `lvmzliemqnieeoruhkik`. The runner verified
three tables and six functions before commit. SOURCE was untouched. This
database result does **not** prove that public application code was deployed or
that the production Vercel schedule has run; verify those separately through
the normal release and observability process.

---

## Configuration Reference

| Setting | Location | Value / Default | Description |
|---------|----------|-----------------|-------------|
| Freshness target | `resultCache.js` / SQL publish RPC | 15 minutes | Success-to-next-due interval and UI stale threshold. |
| Compute timeout | `resultCache.js` | 20 seconds | Bounds one aggregation attempt. |
| Scheduler budget | `resultCache.js` | 25 seconds | Stops launching additional cron work. |
| Jobs per run | `resultCache.js` | 12 | Maximum claimed by one scheduled invocation. |
| Scheduler workers | `resultCache.js` | 2 | In-process claim loops. |
| Global active claims | Migration claim RPC | 8 | Cross-instance concurrency cap. |
| Per-tenant active claims | Migration claim RPC | 2 | Cross-instance tenant cap. |
| Lease lifetime | Migration claim RPC | 90 seconds | Recovery and publication fence lifetime. |
| Personal activity window | Migration claim RPC | 7 days | Scheduler prewarm window. |
| Widget refresh cooldown | Migration touch RPC | 1 minute | Prevents repeated selected-widget requests. |
| Actor refresh limit | Migration touch RPC | 20/minute | Abuse limit per tenant/member. |
| Failure backoff | Migration publish RPC | 30 seconds–1 hour | Exponential retry delay. |
| Cron cadence | `vercel.json` | Every minute | Refresh worker invocation target. |
| Cron authorization | Vercel environment | `CRON_SECRET` required | Exact bearer secret; absent fails closed. |

---

## Diagnostics and Troubleshooting

### Problem: Every saved widget reports cache unavailable

**Symptom:** Data endpoints return HTTP 503 and cards cannot load saved results.  
**Cause:** The cache migration is missing, partially applied, or service-role
RPC access is unavailable.  
**Fix:** Do not add a live-aggregation fallback. Run the offline hash review,
apply the approved migration to DEST, and verify tables/functions using the
runner.

### Problem: Results remain stale beyond 15 minutes

**Symptom:** The card retains data but labels it stale.  
**Cause:** The cron is not authorized/running, backlog exceeds capacity, the
widget is repeatedly failing, or all claims are occupied.  
**Fix:** Check Vercel scheduled invocations and structured scheduler reports.
Inspect `overdue`, `oldestDueAt`, `failed`, and `leased`. Remember that 15
minutes is a target, not an availability guarantee.

### Problem: A personal widget is not prewarmed

**Symptom:** A dormant personal card is cold when revisited.  
**Cause:** Personal widgets leave scheduled eligibility seven days after their
last authorized view.  
**Fix:** This is expected. Opening it records activity and attempts a cold
claim; subsequent scheduled refreshes continue while it remains active.

### Problem: Refresh is disabled or appears not to start new work

**Symptom:** The card keeps its current timestamp after repeated activation.  
**Cause:** Work is already pending, the one-minute widget cooldown applies, or
capacity/backoff makes the request durable but not immediately claimable.  
**Fix:** Respect `retryAfterSeconds`, wait for polling/cron, and inspect the
backlog rather than repeatedly activating Refresh.

### Problem: Cached count and drilldown records differ

**Symptom:** Click-through shows a different live record count.  
**Cause:** The card is a cached successful snapshot; drilldown deliberately
reruns against live source rows and does not cache IDs.  
**Fix:** Refresh the card when a newer aggregate is needed. Do not change
drilldown to reuse historical counts without a separate versioned snapshot
design.

### Read-Only Operational Queries

```sql
SELECT widget_id, tenant_id, scope, updated_at, due_at, last_attempt_at,
       failures, error, lease_until, requested_at
FROM public.dashboard_widget_result_cache
WHERE due_at < now() OR failures > 0 OR lease_until > now()
ORDER BY due_at, widget_id
LIMIT 200;

SELECT count(*) AS eligible,
       count(*) FILTER (WHERE due_at < now()) AS overdue,
       count(*) FILTER (WHERE failures > 0) AS failed,
       count(*) FILTER (WHERE lease_until > now()) AS leased,
       max(updated_at) AS latest_success
FROM public.dashboard_widget_result_cache
WHERE scope = 'shared' OR last_viewed_at > now() - interval '7 days';
```

These queries describe durable database state. They do not prove Vercel cron
delivery or deployment health; correlate them with scheduled invocation logs.
Do not call `dashboard_widget_cache_stats()` during a read-only investigation:
it deletes expired rate-limit and unused tenant records.

### Task 4727: Destination Evidence and Verification Limits

Read-only destination checks at **2026-09-23 19:20:07–19:20:29 UTC** used the
existing `destinationTarget()` validation, `DEST_DATABASE_URL` and
`DEST_SUPABASE_URL`, and the verified Supabase provider CA with hostname
verification enabled. The pinned project was **lvmzliemqnieeoruhkik**; the
database reported `transaction_read_only = on`. Every connection used
`BEGIN READ ONLY`, a ten-second statement timeout, and `ROLLBACK`. No cache
RPC, computation, scheduler invocation, refresh, or migration was run.

Observed database evidence:

- All **56 saved widgets** had cache rows, with **zero missing rows or identity
  mismatches**. The cache sync trigger was enabled.
- **51 shared widgets** were eligible: **50 had successful persisted results**,
  **zero were overdue**, and **one had failed without a previous success**.
- The failed shared widget had nine recorded failures, last attempted at
  18:35:41 UTC and due again at 19:35:41 UTC. Its error was the generic
  client-safe refresh failure. This proves an individual computation problem,
  not its cause.
- The five personal widgets had never been viewed/published and were not
  scheduler eligible. Their overdue timestamps are not an eligible backlog.
- Successful updates ranged from 19:09:35 to **19:19:47 UTC**. The latest
  recorded view was **19:13:21 UTC**. Publication after the latest view is
  consistent with background processing, but does not identify which host or
  invocation performed it.
- No active leases were present. The largest persisted JSON result was
  **3,174 bytes**.
- All three cache-related tables had RLS enabled and no `SELECT` privilege
  for `anon` or `authenticated`. The six expected functions existed; worker
  functions used security-definer execution and `search_path=public`.
- Small aggregate/metadata SELECTs took approximately **149–152 ms each**
  from this workspace over an established SQL connection. These are not
  browser/API timings and do not measure authorization or cold-start time.

These observations **disprove a blanket claim that the destination cache is
missing or never publishes**. They do not establish the cause of slow repeat
loads for a particular authenticated viewer.

Access and rollout limits:

- The deployment skill returned no Replit deployment. This does not establish
  the state of the external Vercel deployment.
- The added Vercel connector rejected a project-list read with HTTP 403,
  `invalidToken: true`. Its authorization type is API key, so the existing
  credential must be repaired rather than using OAuth reauthorization.
  Production URL, deployed commit, production environment variables and cron
  delivery were not verified.
- Supabase MCP callbacks were unavailable in the investigator runtime; this
  did **not** prevent the documented direct, pinned destination SQL checks.
- Workspace `SUPABASE_URL` points to the separate
  `zkvgzcruhniduuswbfyh` project. Its missing REST cache table and empty widget
  probe are **not destination evidence** and must not drive a production
  migration decision.
- At the read-only inspection time, destination functions still showed the
  prior implementation. The subsequent forward upgrade is recorded below;
  it does not establish that application code has been deployed.

**Task 4727 database upgrade:** At approximately **2026-09-23 19:25 UTC**,
after the local PostgreSQL lifecycle tests passed, the reviewed forward
migration `dashboard_widget_refresh_receipts.sql` was applied and committed
to pinned verified-TLS DEST project **lvmzliemqnieeoruhkik**, using SHA-256
`f780c8ba3e28e6aa34e3a7146aef2ad94f10589b14e73f772204e582a76734fb`.
The runner verified four receipt columns, four restricted functions, and
preservation of existing cache data/lease state. SOURCE was untouched.
The historical task 610 SQL and runner remain unchanged. This confirms only
the database protocol rollout, not Vercel application deployment, authenticated
refresh UX, cron delivery, or production latency improvement.

The data and refresh endpoints now emit coarse `Server-Timing` stages:
`access`, `widget`, `cache`, and `total`, with rounded milliseconds and no
identifiers or secrets. Capture those headers on authorized repeat loads
after deployment to separate access resolution, widget lookup and cache work.
No authenticated production timing or before/after performance improvement
was measured in this investigation.

The separately configured `VERCEL_API_TOKEN` was also tried through read-only
project and team discovery. Both requests returned HTTP 403 with
`invalidToken: true`. No authenticated affected Dashboard/Canvas session was
available. The reported slow-repeat-load cause therefore remains unresolved;
this work is not evidence that the public regression has been fixed.

### Local Regression Verification

- Disposable PostgreSQL lifecycle tests passed, including forward-migration
  replay with preservation of existing successful data, independent warm reads,
  lease fencing, capacity contention, semantic edits, failure retention,
  cooldown, and request-correlated publication.
- A local 24-widget benchmark made 24 cold aggregation calls and **zero warm
  aggregation calls** (approximately 384 ms cold / 68 ms warm with synthetic
  3 ms aggregations). These are not production timings.
- API cache/access/embed tests passed, including coarse timing headers.
- WidgetCard unit/mounted tests: **16 passed**.
- Isolated browser fixtures: **2 passed**, covering 18 dashboard cards and
  Canvas cards. These use controlled API responses, not production records.
- Pending feedback is bounded by attempt and two-minute wall-clock limits;
  exhaustion retains saved data, stops the spinner and enables retry. Identity
  changes reset that state.

**Remaining release verification:** restore Vercel read access, identify the
actual deployed revision and scheduled invocation, then trace authorized cold,
warm, refresh and independent reload requests on the affected Dashboard and
Canvas page. Use the timing headers and bounded database metadata together;
neither database installation nor passing fixture tests proves that flow.
The forward database migration is applied to DEST; no new migration remains
pending. Application rollout and the measured production diagnosis remain
pending. The implementation is submitted for merge so deployment can precede
that live verification; this does not establish resolution of the reported
production slowdown.
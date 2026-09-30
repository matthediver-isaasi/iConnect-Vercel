# Membership Renewals Continuation

**Author:** Replit Agent  
**Last Updated:** September 2026  
**Module:** Membership renewal cron

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Execution and Continuation](#execution-and-continuation)
4. [Expiry Enforcement](#expiry-enforcement)
5. [Outcome and Diagnostic Semantics](#outcome-and-diagnostic-semantics)
6. [Configuration and Settings](#configuration-and-settings)
7. [Code Paths and Entry Points](#code-paths-and-entry-points)
8. [Safeguards and Error Handling](#safeguards-and-error-handling)
9. [Database Tables](#database-tables)
10. [Data Flow Diagrams](#data-flow-diagrams)
11. [External Integrations](#external-integrations)
12. [Configuration Reference](#configuration-reference)
13. [Deployment and Read-Only Production Verification](#deployment-and-read-only-production-verification)
14. [Performance Evidence](#performance-evidence)
15. [Troubleshooting](#troubleshooting)

---

## Overview

The membership renewal cron performs pause restarts, automatic and scheduled
membership billing, payment-provider renewals, reminders, scheduled activation,
and annual expiry enforcement. These responsibilities can exceed Vercel's
60-second function limit when a tenant has many memberships. The continuation
runner bounds each invocation, stores progress in PostgreSQL, and lets a later
hourly invocation resume instead of restarting the entire scan.

The core design principle is **checkpoint only completed work**. One global
lease prevents overlapping workers, keyset cursors avoid offset drift, and
financial/provider rows advance only after their current operation returns
without recording an error. Annual expiry mutations additionally use a durable
intent journal, so an invocation interrupted after changing access can repair
the same action without replacing its original provenance.

Deferral is normal capacity management, not failure. Operators can distinguish
`completed`, `deferred`, `failed`, `stalled`, and `busy` outcomes from structured
diagnostics and `scheduled_task_log`. Users should see the same renewal,
reminder, pause, payment, and expiry rules; the change is operational durability,
not a change to eligibility or pricing policy.

---

## Architecture

### Key Files

| File | Purpose |
|------|---------|
| `api/cron/process-membership-renewals.js` | Authenticated hourly endpoint that wires the existing renewal stages into the continuation runner. |
| `api/_lib/membershipRenewalRunner.js` | Owns the lease, time budgets, tenant rotation, stage checkpoints, outcomes, diagnostics, and completion logs. |
| `api/_lib/membershipRenewalBudget.js` | Provides cooperative deadline checks and keyset-paged row iteration. |
| `api/_lib/annualMembershipExpiryEnforcement.js` | Runs resumable member and organisation expiry enforcement with policy caching and an effect journal. |
| `api/_lib/memberPause.js` | Pages and checkpoints scheduled pause restarts. |
| `api/_lib/gocardlessDdRenewals.js` | Pages and checkpoints GoCardless renewal agreement processing. |
| `api/_lib/stripeCardRenewals.js` | Pages and checkpoints Stripe card renewal agreement processing. |
| `api/_lib/membershipReminders.js` | Uses stream-specific cursors for fixed and rolling reminders. |
| `api/_lib/heartbeat.js` | Delivers the one-shot Better Stack success or failure heartbeat. |
| `supabase/migrations/20260922_membership_renewal_cron_state.sql` | Creates the singleton continuation state, lease/discovery RPCs, grants, and keyset indexes. |
| `supabase/migrations/20260922_membership_expiry_action_journal.sql` | Adds pending/completed states to expiry provenance and creates supporting indexes. |

### Design Principles

1. **A global, fenced lease permits one worker at a time**, preventing two invocations from acting on the same renewal rows concurrently.
2. **The lease lasts 120 seconds but is never renewed**, so it outlives a 60-second Vercel invocation while still recovering automatically after an abrupt kill.
3. **Work ends cooperatively between rows**, because abandoning a promise with `Promise.race` would not cancel an in-flight charge, invoice, email, or database write.
4. **Every scan uses deterministic keyset paging**, so server response caps and data changes do not cause silent truncation.
5. **Tenant order rotates after each handoff**, preventing one large or repeatedly failing tenant from starving later tenants.
6. **Discovery and billing are bounded while expiry retains reserved time**, using separate 3-second discovery, 30-second billing, and 48-second total work boundaries.
7. **Expiry policy comes from the purchased snapshot first**, preserving the policy agreed for that term rather than silently applying later configuration.
8. **Monitoring reports business truth**, treating resumable deferral differently from failure and refusing to call an unowned `busy` invocation healthy.

---

## Execution and Continuation

### Lease Claim

Each invocation creates a UUID owner and calls:

```sql
claim_membership_renewal_cron(p_owner uuid)
```

The RPC atomically creates or claims the singleton only when it has no owner or
its lease has expired. A successful claim returns the saved JSON state and
`lease_until`; a competing invocation receives only `{ "claimed": false }` and
cannot see another worker's continuation.

State saves are fenced:

```sql
UPDATE membership_renewal_cron_state
SET state = p_state, ...
WHERE singleton = true
  AND owner = p_owner
  AND lease_until > clock_timestamp();
```

If the owner or lease no longer matches, the save raises
`Renewal cron lease ownership lost`. A stale invocation therefore cannot
overwrite a newer worker's cursor.

### Resumable Tenant Discovery and Scheduling

`membership_renewal_cron_tenants()` returns the union of:

- tenants with an active membership tier configuration;
- tenants with member histories that still need expiry evaluation; and
- tenants with organisation histories that still need expiry evaluation.

The caller orders and pages rows for at most three seconds. It persists
`discoveryOffset` after every page and caches each discovered row in the
tenant registry at `state.tenants[tenant_id]`. If discovery reaches an empty
page, the offset returns to zero for the next full pass. If it reaches the
three-second boundary first, discovery is `deferred`; already cached tenants
still proceed to billing and expiry, and the next invocation resumes from the
saved offset. The registry is intentionally retained between passes so a large
or temporarily slow directory cannot postpone known tenants forever.

Discovery reads have a real transport deadline of the smaller of two seconds
and the time remaining in the discovery slice. An aborted or otherwise failed
read is a real `failed` outcome, not a budget deferral: no successful page was
available to checkpoint.

Invalid or missing `membership_cron_time` settings use 06:00 UTC. At or after
today's configured hour, the runner creates one billing opportunity for that
tenant. It catches up later in the same UTC day if the scheduled invocation was
missed, but does not manufacture billing opportunities for earlier dates.

### Stage Order and Checkpoints

The high-level algorithm is:

```text
claim global lease
resume paged tenant discovery for up to 3 seconds
cache discovered tenants and persist discoveryOffset
register today's eligible billing opportunities
run pause restarts until the 5-second boundary
for each rotated tenant with pending billing:
  run each configured billing stage
  checkpoint each completed row
  persist the next stage only after the current stage succeeds
stop starting billing at 30 seconds
for each rotated tenant:
  run expiry for at most 4 seconds
  checkpoint history/member fan-out progress
stop starting work at 48 seconds
write scheduled_task_log rows in batches of 200, stopping at 54 seconds
release the lease
```

The state JSON contains stage and cursor data rather than business records.
Important fields include `discoveryOffset`, `tenants`, `pauseCursor`,
`pauseNoProgress`, `billing`, `billingAfter`, `expiry`, and `expiryAfter`.
Each pending billing object contains `date`, `stage`, `cursor`, `done`, and
`noProgress` as applicable. Each expiry entry contains `cursor`, `progressAt`,
`completedAt`, and `noProgress`. Reminder processing may store a composite
cursor because fixed, rolling-member, rolling-organisation, and configuration
streams progress independently.

### Cooperative Row Budget

`renewalRows()` checks the deadline before each query and row, loads rows ordered
by a stable ID, and advances with `id > cursor`. It continues until it receives
an empty page; a short page is not treated as the end because an API response cap
may be lower than the requested page size.

```text
while budget remains:
  page WHERE id > cursor ORDER BY id
  if page is empty: stage is complete
  for each row:
    check budget
    await the existing row operation
    if the row recorded an error: do not checkpoint
    checkpoint row.id
```

**Known limitation:** the budget is cooperative. A provider HTTP request or
other operation already in progress may run past its stage boundary. The worker
does not promise that every invocation stays below a boundary once a provider
row has started, and it does not use a timeout race because that would leave
the side effect executing after continuation moved on. Provider-level request
timeouts and idempotency remain the responsibility of the existing integration.

### Bounded Expiry Reads

Expiry database reads use `withRenewalReadDeadline()` with an actual PostgREST
abort signal. Each read gets at most two seconds, reduced further when less
time remains in the current four-second tenant slice. The worker always awaits
the aborted transport's settlement; it does not leave a detached read running.

Only reads are abortable. Queries containing `insert`, `update`, `upsert`, or
`delete` are awaited normally so the continuation cannot move on while a write
is still in flight. The cooperative guard still prevents a new effect from
starting after its slice expires.

There are two deliberately different time outcomes:

| Condition | Classification | Cursor behaviour |
|-----------|----------------|------------------|
| Cooperative `shouldContinue()` boundary reached between operations | `deferred` | Save the last safely handled cursor and resume later. |
| Read transport aborts, returns a PostgREST error, or otherwise fails | `failed` | Do not claim the unread work as complete; surface the actual error. |

An expiry slice returning `complete: false` is a partial budget result and is
healthy if progress remains possible. A thrown read error is never converted
to deferral merely because it occurred near the deadline.

---

## Expiry Enforcement

### Keyset Cursor

The expiry cursor has enough information to resume both history tables and a
large organisation fan-out:

```json
{
  "historyType": "member",
  "afterId": "history-uuid",
  "historyId": "organisation-history-uuid",
  "memberAfterId": "member-uuid"
}
```

Member histories run first, then organisation histories. Organisation member
fan-out checkpoints each fully handled member before continuing. Read-only
history skips can checkpoint once per page because replaying them is safe.

### Batched Configuration Resolution

For each history page, purchased `commitment_snapshot.config` is authoritative.
The worker collects the remaining distinct `config_id` values and loads them in
tenant-scoped batches, caching each result for the invocation. A missing or
cross-tenant configuration fails closed instead of guessing an expiry policy.

### Protection Checks

Before mutating a member, the worker preserves all existing protections:

- tenant administrators are never expired;
- paused members are protected;
- paid next terms prevent expiry;
- current inherited organisation membership protects an individual history;
- current individual membership protects an organisation fan-out member;
- a member moved out of the organisation is not changed;
- ambiguous legacy rolling terms without a trusted commitment are marked for
  review rather than inferred.

Protection queries page until empty, even if the data API returns fewer rows
than requested.

### Intent Journal and Repair

Before any access mutation, the worker inserts a `pending`
`membership_expiry_action` containing the original login and role values. It
never upserts this row, so retries cannot overwrite provenance. Field-level
compare-and-set updates only apply if the member field still equals its recorded
original value.

```text
read journal by tenant + history type + history + member
if completed: no-op
if absent:
  insert pending intent with previous values
for each intended field:
  if already at target: continue
  update only WHERE field = recorded previous value
invalidate sessions when login disablement was intended
mark journal completed
mark history expiry completed
```

An interrupted pending action is repaired from the saved values. Session
invalidation can repeat during repair and must remain idempotent. A completed
journal is always a no-op.

---

## Outcome and Diagnostic Semantics

### Outcomes

| Outcome | Meaning | Healthy heartbeat? |
|---------|---------|--------------------|
| `completed` | The claimed invocation completed all currently selected work with no errors. | Yes |
| `deferred` | The invocation reached a cooperative boundary after checkpointing safe progress; later runs have pending work. | Yes |
| `failed` | A query, effect, checkpoint, provider row, completion log, or lease operation reported a real error. | No |
| `stalled` | Pause, billing, or expiry reaches three consecutive budget deferrals without advancing its saved cursor/stage or examining/enforcing expiry work. | No |
| `busy` | Another owner holds the lease. This invocation did not prove that the owner is healthy. | No heartbeat is sent by this invocation |

`scheduled_task_log.status` maps `completed` to `success`, `deferred` to
`partial`, and `failed`/`stalled` to `error`. Its JSON details include duration,
errors, deferrals, processed/skipped totals, expiry progress, and billing stage.

### Structured Diagnostics

The runner emits one-line JSON diagnostics such as:

```json
{
  "job": "membership_renewals",
  "owner": "worker-uuid",
  "stage": "expiry",
  "event": "progress",
  "elapsed_ms": 37120,
  "tenantId": "tenant-uuid",
  "examined": 100,
  "enforced": 2,
  "cursor": { "historyType": "member", "afterId": "history-uuid" }
}
```

Events include `start`, `end`, `progress`, `deferred`, `error`, and `busy`.
Stage-end diagnostics include `duration_ms`. Discovery deferral includes
`nextOffset`. These records answer which stage is slow, whether discovery and
work cursors advance, and whether pause, billing, or expiry is repeatedly making
no progress without exposing renewal state to unauthorised callers.

---

## Configuration and Settings

### Tenant Cron Time

`system_settings.setting_key = 'membership_cron_time'` controls the UTC billing
hour. Accepted values are hours `0`–`23`, optionally followed by `:00`–`:59`.
Missing or invalid values default to hour 6. Expiry remains eligible every hour
and is not held behind the tenant billing hour.

### Runner Limits

Limits are defined by `RENEWAL_LIMITS` and injectable in tests:

- **Discovery boundary:** 3,000 ms from invocation start.
- **Expiry/discovery read transport timeout:** 2,000 ms, capped by remaining
  slice time.
- **Pause restart boundary:** 5,000 ms from invocation start.
- **Billing boundary:** 30,000 ms from invocation start.
- **Total work boundary:** 48,000 ms from invocation start.
- **Per-tenant expiry slice:** 4,000 ms, capped by the total boundary.
- **Finalisation boundary:** 54,000 ms from invocation start.

The 48-second work boundary reserves time for completion logging and release.
Completion logs are inserted in batches of 200 and no new batch starts at or
after 54 seconds. Missing log rows increment the real error count, making the
outcome unhealthy rather than pretending that incomplete observability
succeeded. The remaining margin before Vercel's 60-second ceiling is reserved
for lease release, heartbeat delivery, and response finalisation.

### Legacy Calling Behaviour

The paging helpers preserve their previous behaviour when no renewal control is
provided. The bounded cron injects `results.__renewalControl`, while pause
restarts also accept an explicit `control` option. Other call sites can continue
to call these helpers without continuation state.

---

## Code Paths and Entry Points

### Hourly Cron Endpoint

**File:** `api/cron/process-membership-renewals.js`  
**Trigger:** Vercel schedule `0 * * * *`, authenticated by `CRON_SECRET`.

1. Reject an unauthorised invocation before creating a heartbeat reporter.
2. Supply the database, pause worker, expiry worker, and ordered billing stages
   to `runMembershipRenewals()`.
3. Allow the runner to claim, resume discovery, process, checkpoint, batch-log,
   and release.
4. Send one Better Stack heartbeat according to the returned business outcome.
5. Return the bounded invocation result.

**Important:** apply both required migrations before deploying endpoint wiring.
The migration deployment and production release require explicit approval and
were not performed as part of this implementation work.

### Renewal Row Helpers

**Files:** `memberPause.js`, `gocardlessDdRenewals.js`,
`stripeCardRenewals.js`, and `membershipReminders.js`  
**Trigger:** Their corresponding stage in the claimed cron invocation.

Each helper pages candidates, retains existing financial and eligibility guards,
awaits its current effect, and checkpoints only a successful row. A row that
increments `results.errors` stops cursor advancement so it remains visible for
repair rather than being silently skipped.

Pause and billing track no-progress independently. A cooperative pause deferral
increments `pauseNoProgress` only when `pauseCursor` did not change. A billing
deferral increments the pending tenant's `noProgress` only when neither its
stage nor cursor changed. Progress resets the corresponding counter to zero;
three consecutive no-progress deferrals make the invocation `stalled`.

### Annual Expiry Worker

**File:** `annualMembershipExpiryEnforcement.js`  
**Function:** `processTenantAnnualExpirySweep(client, tenantId, results, now, options)`

The runner passes the saved cursor, cooperative predicate, checkpoint callback,
and progress callback. The worker returns:

```json
{
  "enforced": 2,
  "examined": 100,
  "complete": false,
  "cursor": { "historyType": "organisation", "afterId": "history-uuid" }
}
```

`complete: false` is a safe deferral, while thrown query, journal, session, or
checkpoint errors are failures. Expiry no-progress increments only when an
incomplete slice reports zero examined and zero enforced rows; progress resets
the counter, and three consecutive no-progress slices are `stalled`.

---

## Safeguards and Error Handling

### Authentication Before Monitoring

The cron must validate `CRON_SECRET` before making any Better Stack request or
cross-tenant database query. Unauthorised requests neither work nor ping health.

### Exclusive Global Lease

The singleton primary key plus conditional claim allows exactly one owner.
Ownership and unexpired lease predicates fence every save and release.

### Safe Financial Checkpoints

No checkpoint occurs until the row's awaited work finishes and no new row error
was recorded. An in-flight provider call is never treated as cancelled merely
because the local time boundary passed.

This is a safety rule, not a hard timing guarantee. A started provider row can
outlive the cron's local billing or work boundary, and the finalisation reserve
cannot pre-empt that row.

### Error Versus Deferral

`RENEWAL_BUDGET_EXHAUSTED` means progress was safely checkpointed for later.
Database, provider, journal, session invalidation, and save errors remain errors.
The runner does not relabel attempted work as deferral.

The two-second expiry/discovery read deadline aborts and awaits the actual read
transport. A timeout is therefore a true read error and unhealthy. By contrast,
a cooperative check that declines to start the next read or effect is a healthy
partial-budget deferral.

### Expiry Provenance

Pending intent is durable before mutation, completed actions are no-ops, and
repairs use compare-and-set against immutable previous values. This prevents a
retry from overwriting an administrator's unrelated later change.

### API Caps and Fairness

Tenant discovery, histories, members, agreements, reminders, and protection
checks explicitly page. The runner rotates tenant start positions after each
handoff, including errors, to avoid starvation.

### Bounded Completion Logging

The runner builds one completion row per known tenant and inserts rows in
batches of 200. It stops starting batches at 54 seconds. Any unwritten remainder
or batch insert error is recorded as `completion-log` failure, so heartbeat
health does not conceal missing tenant logs.

---

## Database Tables

### `membership_renewal_cron_state`

Singleton continuation and lease state. Direct table access is revoked from
`PUBLIC`, `anon`, `authenticated`, and `service_role`; the service role uses
the security-definer RPCs.

| Column | Type | Description |
|--------|------|-------------|
| `singleton` | `boolean` | Primary key constrained to `true`, ensuring one global row. |
| `owner` | `uuid` | Current worker UUID, or `NULL` when released. |
| `lease_until` | `timestamptz` | Fixed claim expiry; not renewed by the worker. |
| `state` | `jsonb` | Object containing cached tenants, discovery offset, pause/billing/expiry cursors, no-progress counters, and tenant rotation positions. |
| `updated_at` | `timestamptz` | Last state or ownership change. |

### `membership_expiry_action`

Durable provenance and repair journal for access effects. Existing columns such
as tenant, history, member, previous values, intended values, timestamps, and
details remain in place.

| Column | Type | Description |
|--------|------|-------------|
| `action_state` | `text` | `pending` before effects or `completed` after all effects. |
| `completed_at` | `timestamptz` | Time the pending action completed; `NULL` while repair is needed. |

### `scheduled_task_log`

Existing operational log table. Renewal rows use task name
`membership_renewals`; `details` stores the truthful outcome, counters,
progress, and billing continuation.

### Supporting Indexes

| Index | Columns / Predicate | Purpose |
|-------|---------------------|---------|
| `member_membership_history_expiry_keyset_idx` | `(tenant_id, id) WHERE expiry_enforced_at IS NULL` | Pages member expiry candidates. |
| `organisation_membership_history_expiry_keyset_idx` | `(tenant_id, id) WHERE expiry_enforced_at IS NULL` | Pages organisation expiry candidates. |
| `member_organisation_expiry_keyset_idx` | `(tenant_id, organization_id, id)` | Pages organisation member fan-out. |

---

## Data Flow Diagrams

### Normal Claimed Invocation

```text
Hourly authorised request
  → Claim singleton lease
    → Resume tenant discoveryOffset and update cached tenant registry
      → Resume pause cursor
        → Resume today's billing stage/row cursor
          → Rotate through bounded expiry slices
            → Batch-write scheduled_task_log before 54 seconds
              → Release lease
                → Send one truthful heartbeat
```

### Cooperative Deferral

```text
Stage checks boundary before next row
  → Boundary reached
    → Save last fully completed cursor
      → Mark invocation deferred
        → Finalise and release
          → Next hourly invocation claims saved state
            → Resume after completed cursor
```

### Discovery Deferral

```text
Resume membership_renewal_cron_tenants from discoveryOffset
  → Read and cache a page
    → Persist next offset
      → Three-second discovery budget reached?
        → Yes: mark deferred and process already cached tenants
          → Next invocation resumes discovery at saved offset
        → No, empty page: reset offset to zero and use full cached registry
```

### Interrupted Expiry Effect

```text
Write pending expiry intent
  → Apply field-level access mutation
    → Invocation is interrupted before completion
      → Lease expires
        → Later worker reads pending intent
          → Reapply only missing intended fields
            → Invalidate sessions idempotently
              → Mark journal and history completed
```

---

## External Integrations

### Accounting Provider

Organisation and member renewal stages retain the existing invoice creation and
linking logic. Continuation does not mark a row complete until the accounting
operation returns successfully. Provider idempotency and existing invoice guards
remain essential if the platform terminates after the remote effect but before a
local checkpoint.

### GoCardless and Stripe

Recurring agreement scans now page and checkpoint agreement IDs. The worker
does not cancel an already-started provider request when its cooperative budget
expires. The Stripe SDK default in this path is an 80-second request timeout
with two network retries, which is longer than the cron work budget. GoCardless
has a 15-second per-request abort timeout, but that timer is cleared when the
response headers arrive and therefore does not cover later response-body
parsing. These verified integration limits mean a started provider row can
still overrun the runner's local boundary. Existing provider status checks,
payment guards, and idempotency rules remain unchanged.

### Email and Reminders

Reminder streams maintain separate cursors. Existing delivery ledgers and
suppression checks continue to decide whether a message is sent. Continuation
does not weaken those business rules. Mailgun uses an actual 15-second
socket/response transport timeout by default. As with payment providers, the
runner cooperatively avoids starting the next row after its boundary; it does
not promise to pre-empt a send already accepted by the transport.

### Better Stack

The heartbeat is best effort with a two-second delivery timeout. Monitoring
delivery errors are logged and swallowed so monitoring cannot change renewal
business results. See `guides/better-stack-cron-heartbeats.md` for outcome
mapping and production verification.

---

## Configuration Reference

| Setting | Location | Values | Default | Description |
|---------|----------|--------|---------|-------------|
| `membership_cron_time` | `system_settings` | UTC hour, optionally `HH:MM` | `06:00` UTC | Earliest hour at which today's tenant billing opportunity is registered. |
| `discoveryMs` | `RENEWAL_LIMITS` | Milliseconds | `3000` | Maximum tenant-discovery slice before saving `discoveryOffset`. |
| `readMs` | `RENEWAL_LIMITS` | Milliseconds | `2000` | Actual abort-and-await timeout for discovery and expiry reads, capped by remaining slice time. |
| `pauseMs` | `RENEWAL_LIMITS` | Milliseconds | `5000` | Pause-restart cooperative boundary. |
| `billingMs` | `RENEWAL_LIMITS` | Milliseconds | `30000` | Stops starting further billing rows/stages. |
| `workMs` | `RENEWAL_LIMITS` | Milliseconds | `48000` | Stops starting further expiry tenant slices. |
| `tenantExpiryMs` | `RENEWAL_LIMITS` | Milliseconds | `4000` | Maximum cooperative expiry slice per tenant. |
| `finalizationMs` | `RENEWAL_LIMITS` | Milliseconds | `54000` | Stops starting further 200-row completion-log batches. |
| Lease duration | State migration | PostgreSQL interval | `120 seconds` | Fixed ownership window, deliberately longer than Vercel's 60 seconds. |
| Stripe request defaults | Stripe SDK configuration | Timeout / retries | `80000 ms` / `2` | Can exceed the renewal work budget after a provider row starts. |
| GoCardless request timeout | `api/_lib/gocardless.js` | Milliseconds | `15000` | Actual request abort through response headers; response body parsing is outside this timer. |
| `MAILGUN_TIMEOUT_MS` | Mailgun client configuration | Milliseconds | `15000` | Actual socket/response timeout for email transport. |
| `BETTERSTACK_HEARTBEAT_MEMBERSHIP_RENEWALS_URL` | Vercel production environment | Better Stack heartbeat URL | Unset | Enables renewal heartbeat delivery. |

---

## Deployment and Read-Only Production Verification

### Approval and Deployment Order

**Production migration and release approval is still required. Nothing in this
task applied a production migration, invoked the production cron, sent an email,
created an invoice, changed access, or contacted a payment provider.**

The release order is:

1. Obtain explicit approval for the production database migration.
2. Apply `20260922_membership_expiry_action_journal.sql`.
3. Apply `20260922_membership_renewal_cron_state.sql`.
4. Verify the tables, functions, grants, constraints, and indexes read-only.
5. Deploy the application code that wires the handler to the bounded runner.
6. Observe naturally scheduled hourly runs; do not manually invoke the live
   endpoint merely to test it.

### Pre-Release Read-Only SQL

The following examples inspect readiness and do not modify data:

```sql
SELECT to_regclass('public.membership_renewal_cron_state') AS continuation_table,
       to_regclass('public.membership_expiry_action') AS expiry_journal;

SELECT routine_name, security_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'claim_membership_renewal_cron',
    'save_membership_renewal_cron',
    'membership_renewal_cron_tenants'
  )
ORDER BY routine_name;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'member_membership_history_expiry_keyset_idx',
    'organisation_membership_history_expiry_keyset_idx',
    'member_organisation_expiry_keyset_idx'
  )
ORDER BY indexname;
```

After migration, inspect state without calling the mutating claim/save RPCs:

```sql
SELECT singleton, owner, lease_until, updated_at,
       jsonb_object_keys(state) AS state_section
FROM public.membership_renewal_cron_state
ORDER BY state_section;

SELECT action_state, count(*)
FROM public.membership_expiry_action
GROUP BY action_state
ORDER BY action_state;
```

### Naturally Scheduled Verification

After approved deployment, wait for normal `0 * * * *` Vercel invocations and
verify all of the following:

1. Vercel shows no HTTP 504 for the renewal endpoint.
2. Structured logs contain `claim`, stage `start`/`end`, expiry `progress`, and
   `finalization` records with plausible durations; discovery deferrals show an
   advancing `nextOffset`.
3. Discovery offset and cached tenant count progress on large registries, and
   pause, billing, and expiry cursors/stages advance across naturally scheduled
   invocations; no-progress counters do not repeatedly reach the stalled
   threshold.
4. `scheduled_task_log.details` identifies the actual billing stage and
   `completed` or `deferred` progress, rather than reporting a timeout as
   success.
5. The Better Stack membership-renewal monitor receives the expected successful
   delivery from a healthy `completed` or `deferred` owner invocation.
6. Any `failed`/`stalled` invocation uses the failure heartbeat, while a `busy`
   invocation does not emit a misleading success.

Read-only log queries:

```sql
SELECT executed_at, tenant_id, status,
       details::jsonb->>'outcome' AS outcome,
       details::jsonb->>'duration_ms' AS duration_ms,
       details::jsonb->'billing' AS billing,
       details::jsonb->'progress' AS progress,
       details::jsonb->>'errors' AS errors,
       details::jsonb->>'deferred' AS deferred
FROM public.scheduled_task_log
WHERE task_name = 'membership_renewals'
ORDER BY executed_at DESC
LIMIT 100;

SELECT owner, lease_until, updated_at, state
FROM public.membership_renewal_cron_state
WHERE singleton = true;

SELECT action_state, count(*) AS actions,
       min(applied_at) AS oldest_applied_at,
       min(completed_at) FILTER (WHERE action_state = 'completed') AS first_completed_at
FROM public.membership_expiry_action
GROUP BY action_state
ORDER BY action_state;
```

These queries confirm stored progress only. Better Stack delivery must be
confirmed in Better Stack itself, and HTTP 504 absence must be confirmed in the
deployment platform's naturally scheduled request records.

---

## Performance Evidence

The expiry N+1 hypothesis was reproduced with an isolated simulated workload of
868 policy-disabled histories and 70 ms latency per database read:

| Implementation | Simulated operations | Simulated duration |
|----------------|----------------------|--------------------|
| Previous per-history policy lookup | 871 reads | 60,970 ms |
| Batched policy cache and continuation | 13 reads + 10 checkpoint writes | 1,610 ms |

This is a deterministic benchmark of query shape, not live production proof. It
does not include real network variability, provider latency, database load,
Vercel cold starts, or live data distribution. Production success must be
established only through the approved naturally scheduled verification above.

---

## Troubleshooting

### Problem: Invocation reports `busy`

**Symptom:** The request does no work and emits no heartbeat.  
**Cause:** Another owner has an unexpired 120-second lease.  
**Fix:** Check the state row and the owning invocation's logs. Wait for normal
lease expiry; do not clear ownership manually unless an approved incident
procedure establishes that no owner can still write.

### Problem: Renewal remains `deferred`

**Symptom:** Healthy runs finish under the platform limit but pending cursors
remain.  
**Cause:** The workload exceeds one invocation's cooperative capacity.  
**Fix:** Confirm cursors and examined counts advance on each natural run.
Deferral with progress is expected; repeated no-progress expiry slices become
`stalled` and require investigation. Pause and billing also become stalled
after three budget deferrals with no cursor/stage progress.

### Problem: Outcome is `stalled`

**Symptom:** The same tenant has three incomplete expiry slices with no examined
or enforced work.  
**Cause:** Discovery, pause, billing, or expiry may repeatedly consume its
slice before a safe checkpoint, or a started provider row may outlive the local
budget.  
**Fix:** Correlate owner, tenant, stage timing, `discoveryOffset`, stage, cursor,
and no-progress diagnostics; inspect database query performance and the
specific next candidate read-only. Remember that Stripe's request defaults can
exceed the entire cron budget.

### Problem: Expiry reports a timeout as `failed`

**Symptom:** The run fails rather than defers when a read reaches two seconds.  
**Cause:** This is intentional: the actual PostgREST read transport was aborted
and awaited, so no completed page exists to checkpoint.  
**Fix:** Investigate the slow query/index and allow the next scheduled owner to
retry. Do not relabel the error as a partial budget deferral.

### Problem: Some completion logs are missing

**Symptom:** Finalisation reports `Completion log budget exhausted` or a batch
insert error and the heartbeat is unhealthy.  
**Cause:** A prior operation left insufficient time before the 54-second
logging cutoff, or the 200-row batch insert failed.  
**Fix:** Inspect the preceding long-running stage/provider row and database
write error. Missing logs are intentionally treated as failure.

### Problem: Lease ownership lost

**Symptom:** A state save or release fails with `Renewal cron lease ownership
lost`.  
**Cause:** The 120-second lease expired or another owner claimed after expiry.  
**Fix:** Treat the invocation as failed. Inspect long-running in-flight
operations and do not trust its later state writes.

### Problem: Pending expiry actions accumulate

**Symptom:** `membership_expiry_action.action_state = 'pending'` grows across
several scheduled runs.  
**Cause:** An invocation was interrupted between intent and completion, or
repair is repeatedly failing.  
**Fix:** Review failed expiry diagnostics and the journal/history/member rows
read-only. Do not rewrite provenance; fix the underlying error and allow the
bounded worker to repair the pending action.

### Problem: Better Stack says the cron is down

**Symptom:** The scheduled log looks healthy but Better Stack misses a ping.  
**Cause:** The heartbeat URL may be missing, delivery may have timed out, the
invocation may have been `busy`, or the owner may have failed before finalising.  
**Fix:** Check the configured production variable, `[monitoring]` warnings, the
owner's final outcome, and Better Stack event history. Heartbeat delivery is
best effort and distinct from business completion.
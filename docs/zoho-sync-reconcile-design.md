# Outbound Reconcile Cron — Design Proposal

**Status:** Proposal. No code changes yet.
**Companion to:** [`docs/zoho-sync-coverage-audit.md`](./zoho-sync-coverage-audit.md)
**Mental model:** iConnect is the brain and source of truth. Zoho CRM is a backup of member/organization data the client wants. We already have inbound (Zoho → iConnect) covered well; this design closes the outbound gap (iConnect → Zoho) without forcing every write site to remember to call sync.

---

## 1. Goal

Add a scheduled job that walks the `zoho_crm_sync_mapping` table, finds rows in `member`, `organization`, `member_preference_value`, and `organization_preference_value` whose local `updated_at` is newer than the last successful outbound sync, and replays them through the existing `syncEntityToZohoCrm` engine.

Two non-goals worth being explicit about:

- **Not a replacement for live sync.** The handful of entity-API write sites that already call `triggerZohoCrmSync` (and the small number of new inline calls proposed in §5 of the audit) still fire immediately. The cron is a safety net, not the primary path.
- **Not a re-implementation of the sync engine.** We re-use `syncEntityToZohoCrm` and `zoho_crm_sync_state` exactly as they are today. The only new code is the watermark scan and the dispatcher that feeds entity IDs into the existing engine.

---

## 2. Where this slots in

Today's outbound flow:

```
write site ──► triggerZohoCrmSync ──► syncEntityToZohoCrm ──► Zoho API
                       │
                       └─ records hash + timestamp in zoho_crm_sync_state
                          (direction='outbound')
```

Today's inbound flow (already exists):

```
cron/zoho-crm-reconcile.js ──► pollZohoCrmReconciliation
                                       │
                                       └─ pulls modified records from Zoho,
                                          writes them locally, records
                                          state with direction='inbound'
```

What we're adding:

```
cron/zoho-crm-reconcile-outbound.js ──► scanLocalDriftForTenant
                                                 │
                                                 └─ for each entity row where
                                                    updated_at > last outbound
                                                    sync, call syncEntityToZohoCrm
                                                    with action='reconcile'
```

It mirrors the existing inbound poller in shape, lives in the same `api/cron/` directory, and reuses the same engine/state table. The mapping table already has `is_enabled` and `sync_direction` columns — we filter on `outbound` / `bidirectional`.

---

## 3. Algorithm

For each tenant that has at least one mapping with `is_enabled=true` and `sync_direction in ('outbound','bidirectional')`:

1. **Resolve enabled entity types for this tenant** from `zoho_crm_sync_mapping` (today: `member`, `organization`).
2. For each enabled entity type:
   1. Pull the candidate set: rows in the entity table whose `updated_at` is newer than the most recent `zoho_crm_sync_state.last_synced_at` for `(tenant_id, entity_type, entity_id, direction='outbound')`.
   2. Cap the batch (e.g. 200 rows per entity per tick — see §7 throttling).
   3. For each candidate, call `syncEntityToZohoCrm(tenantId, entityType, entityId, { action: 'reconcile', source: 'reconcile-outbound' })`.
   4. The engine's existing payload-hash + ECHO_DEBOUNCE guards (`api/_lib/zohoCrmSync.js:228`, `665-672`) take care of the no-op case — if nothing actually changed since the last sync, the call short-circuits and no Zoho API request is made.
3. **Preference-value tables** (see §5): treat any change to a `member_preference_value` or `organization_preference_value` row as a write to its parent `member` / `organization`, by bumping the parent into the candidate set. The engine already includes preference values in the outbound payload, so we don't need a separate sync path — we just need the parent's `updated_at` to move, or we identify the parent from the pref-value row.

The query for the candidate set is a single SQL statement per entity type per tenant:

```sql
SELECT e.id
FROM   member e
LEFT   JOIN zoho_crm_sync_state s
       ON s.tenant_id  = e.tenant_id
      AND s.entity_type = 'member'
      AND s.entity_id   = e.id
      AND s.direction   = 'outbound'
WHERE  e.tenant_id = $1
AND    (s.last_synced_at IS NULL OR e.updated_at > s.last_synced_at)
ORDER  BY e.updated_at ASC
LIMIT  200;
```

Order-by-ascending matters: if we're behind, we want to drain the oldest drift first so a single Zoho outage doesn't permanently starve old rows.

---

## 4. Watermark semantics

We rely on three columns that already exist:

| Column | Source | Used for |
|---|---|---|
| `member.updated_at` / `organization.updated_at` | Existing schema; Postgres maintains via trigger | Drift detection |
| `zoho_crm_sync_state.last_synced_at` | Written by `recordSyncState` (`zohoCrmSync.js:553`) | Watermark |
| `zoho_crm_sync_state.payload_hash` | Same | No-op short-circuit |

No schema changes required for the basic loop. **Caveat:** confirm in implementation that `member.updated_at` and `organization.updated_at` are bumped on every write that touches the tables (including bulk admin one-shots and scripts). Quick check in §9.

---

## 5. Preference values — DECIDED: option (a)

The pref-value tables are row-per-key, which means a single user toggling five preferences produces five `member_preference_value` writes but should produce one outbound sync of the parent `member`.

**Decision (locked):** promote pref-value writes to the parent's watermark via a database trigger.

Add an `AFTER INSERT OR UPDATE OR DELETE` trigger on each pref-value table:

```sql
-- new migration: supabase/migrations/<timestamp>_pref_value_bumps_parent.sql

CREATE OR REPLACE FUNCTION bump_member_updated_at_from_pref()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE member
     SET updated_at = now()
   WHERE id = COALESCE(NEW.member_id, OLD.member_id);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_member_pref_value_bump_parent
AFTER INSERT OR UPDATE OR DELETE ON member_preference_value
FOR EACH ROW EXECUTE FUNCTION bump_member_updated_at_from_pref();

-- equivalent function + trigger for organization_preference_value
-- (uses organization_id and updates the organization table)
```

Properties:
- The reconcile loop never has to know pref tables exist — it only scans parents.
- Any future consumer of `member.updated_at` (audit log, cache invalidator, search index) gets the same correctness for free.
- `COALESCE(NEW, OLD)` makes the trigger handle inserts, updates, and deletes uniformly.
- Trigger is `AFTER` so it doesn't block the original write transaction's logic.

**Risk to watch in implementation:** if a single transaction toggles many preferences for the same parent, the trigger fires once per row and bumps `updated_at` repeatedly within the same transaction. That's fine functionally (final value is `now()` of commit time), and Postgres absorbs the cost cheaply, but it's worth noting in the migration comment so a future reviewer doesn't think it's a bug.

---

## 6. Deletes — DECIDED: tombstone via DB trigger

**Requirement (locked):** when a `member` or `organization` is deleted in iConnect, the corresponding Zoho CRM record must be deleted too. Otherwise reconciliation counts will diverge and we lose the "is the backup current?" guarantee.

**Schema reality** (verified): `member` and `organization` are hard-deleted — there is no `deleted_at` / `is_deleted` column on either table. Real production delete sites today:

- `api/_lib/provisionTenantService.js:124,137` — provisioning rollback (rare; only on failed tenant setup).
- `scripts/migrations/*.{sql,mjs}` — operator scripts (`delete-iconnect-orgs.mjs`, `fix-duplicate-members.mjs`, `delete-tenant-39dd5564.sql`, `dedupe_members.sql`).

App-code-only hooks would miss the operator scripts (and any future ones), so we go with a **database-level tombstone**:

```sql
-- new migration: supabase/migrations/<timestamp>_zoho_sync_tombstone.sql

CREATE TABLE zoho_crm_sync_tombstone (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  entity_type   text        NOT NULL CHECK (entity_type IN ('member','organization')),
  entity_id     uuid        NOT NULL,
  zoho_crm_id   text,                   -- captured at delete time (engine needs it)
  zoho_crm_module text,                 -- captured at delete time
  deleted_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,            -- set when the cron successfully pushes the delete to Zoho
  attempts      int         NOT NULL DEFAULT 0,
  last_error    text
);

CREATE INDEX idx_zoho_crm_sync_tombstone_pending
  ON zoho_crm_sync_tombstone (tenant_id, entity_type)
  WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION record_member_tombstone()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO zoho_crm_sync_tombstone
    (tenant_id, entity_type, entity_id, zoho_crm_id, zoho_crm_module)
  VALUES
    (OLD.tenant_id, 'member', OLD.id, OLD.zoho_crm_id, OLD.zoho_crm_module);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_member_tombstone
AFTER DELETE ON member
FOR EACH ROW EXECUTE FUNCTION record_member_tombstone();

-- equivalent function + trigger for organization
```

**Why a trigger, not an app-code hook:**

- Catches deletes from operator scripts and any future delete site automatically — no risk of someone forgetting.
- Captures `zoho_crm_id` / `zoho_crm_module` at the exact moment of the delete (the engine needs these to call Zoho's `DELETE /crm/v6/<module>/<id>` endpoint, and they're gone from the table by the time the cron runs).
- Tied to the transaction: if the delete rolls back, the tombstone row rolls back too. No false positives.

**How the cron drains the queue:**

The outbound reconcile cron gets a third pass per tenant:

1. Updated parents (member / organization) — §3.
2. (Implicitly) parents bumped by pref-value changes — §5.
3. **Pending tombstones** — `SELECT * FROM zoho_crm_sync_tombstone WHERE tenant_id = $1 AND processed_at IS NULL ORDER BY deleted_at ASC LIMIT 100`. For each row:
   - If `zoho_crm_id` is null → mark `processed_at = now()` immediately (nothing to delete in Zoho; the local row was never synced).
   - Otherwise call a new helper `deleteEntityFromZohoCrm(tenantId, entityType, zohoCrmId, zohoCrmModule)` in `api/_lib/zohoCrmSync.js` that wraps the existing Zoho client's delete call.
   - On success: set `processed_at = now()`.
   - On failure: increment `attempts`, write `last_error`, leave `processed_at` null. The next tick retries.
   - Treat a Zoho 404 as success (the record is already gone — that's what we wanted).

**Garbage collection:** processed tombstones are kept indefinitely so they double as an audit trail. A separate housekeeping job (or `pg_cron` task) can prune `processed_at < now() - interval '90 days'` later if the table grows large.

**Re-issuing inserts:** if a deleted member ID is later re-created with the same UUID (unlikely but possible in test environments), the tombstone is independent from the new row's outbound state, so the new insert syncs normally.

This adds roughly 30 lines of SQL (one migration) and ~50 lines in `zohoCrmSync.js` for the delete dispatcher.

---

## 7. Throttling and API budget

Zoho CRM enforces per-org API call limits. The cron must respect them.

- **Batch cap per tick:** 200 rows per entity type per tenant. This is the per-iteration upper bound; in steady state most ticks will sync 0–10 rows.
- **Inter-call delay:** small jitter (e.g. 50–150 ms) between `syncEntityToZohoCrm` calls so a backlog drain doesn't burst the API.
- **Concurrency:** sequential within a tenant; tenants processed sequentially in v1 (matches the existing inbound poller). Parallelism can be added later if drain time becomes an issue.
- **Backoff on 429 / 5xx from Zoho:** the existing engine already handles individual call failures by logging and recording an error state. The cron should additionally bail out of the current tenant's loop if it sees N consecutive failures, so a Zoho outage doesn't burn the API budget retrying every drifted row.

Budget math: at one tick every 5 minutes and 200 rows per tenant per entity per tick, worst-case drain rate is 48,000 syncs/day per entity per tenant. In practice steady-state will be a tiny fraction of that.

---

## 8. Schedule

- **Interval:** every 5 minutes. Same cadence the inbound poller already uses; aligns with Vercel Cron's minimum granularity and keeps the user-visible "Zoho is up to date" promise within tolerance for a backup system.
- **Lock:** single-instance via a `zoho_crm_outbound_reconcile_lock` row keyed on `(tenant_id)` with a stale-after-N-minutes rule, OR rely on Vercel Cron's built-in single-execution guarantee per schedule. Either is fine; pick whatever matches how the existing inbound poller is deployed.

---

## 9. Pre-flight verification (before writing code)

A short list of "make sure these are true before we ship":

1. `member.updated_at` and `organization.updated_at` are populated and bumped by every write path. Quick check: a Postgres trigger or a default + `ON UPDATE` clause in the schema. If any write site sets `updated_at` to a stale value (e.g. preserved from import), the reconcile will miss it.
2. `zoho_crm_sync_state` has a row per `(tenant, entity_type, entity_id, direction)` after a successful outbound sync today. (Spot-check: pick a member that has been synced recently and confirm the row exists with `direction='outbound'`.) If not, the very first reconcile pass will treat *every* row as drifted; that's fine for a one-off but worth knowing.
3. The Zoho CRM client (`api/_lib/zohoCrmClient.js`) exposes a delete operation (or one can be added cleanly) — the tombstone drain in §6 needs it.
4. **Already verified:** deletes for `member` / `organization` are hard-deletes (no `deleted_at` column), and pref-value tables (`member_preference_value`, `organization_preference_value`) carry `member_id` / `organization_id` foreign keys, so the §5 and §6 triggers can be written without further schema work.

---

## 10. Observability

Two log lines per tick:

```
[cron/zoho-crm-reconcile-outbound] tenant=<id> entity=member candidates=12 synced=10 noop=2 failed=0 duration_ms=<n>
[cron/zoho-crm-reconcile-outbound] tenant=<id> entity=organization candidates=3 synced=3 noop=0 failed=0 duration_ms=<n>
```

Plus an aggregate at the end of each run, matching the format the existing `zoho-crm-reconcile.js` cron uses, so both jobs look the same in the cron logs.

A small admin-page extension on `/admin/zoho-crm-sync` could later show "drift count" (how many local rows are currently ahead of their last outbound sync, per tenant per entity). This is a one-query addition and gives operators a live "is the backup current?" indicator. Not in scope for v1.

---

## 11. What this design does NOT do

- **Does not replace the inline `triggerZohoCrmSync` calls** that already exist in the entity APIs and admin endpoints. Those continue to give immediate sync for the user-facing edits where latency matters.
- **Does not replace the targeted point-fixes recommended in audit §5** for the half-dozen flows where the next step in the workflow needs the CRM record to exist *before* the cron's next pass (membership application welcome email, due-diligence stage transitions, fundraising registration, member self-service org PATCH). Those are still worth the small one-line additions.
- **Does not touch the inbound path.** The existing `cron/zoho-crm-reconcile.js` and its `pollZohoCrmReconciliation` flow are unchanged.

---

## 12. Estimated scope

All five items below are required (no optionals — both pref-value and delete handling are now locked in):

- One new cron file: `api/cron/zoho-crm-reconcile-outbound.js` (~80 lines, mirrors the existing inbound reconcile).
- One new function in `api/_lib/zohoCrmSync.js`: `pollLocalOutboundDrift(tenantId, options)` (~120 lines including per-entity SQL and the dispatch loop), plus a small `deleteEntityFromZohoCrm` helper for the tombstone drain (~50 lines).
- One migration for the **preference-value parent-bump triggers** (§5): two trigger functions + two triggers, ~30 lines of SQL.
- One migration for the **tombstone table + delete triggers** (§6): table + index + two trigger functions + two triggers, ~60 lines of SQL.
- `vercel.json` cron entry (one line).

Total: one focused implementation PR (~400 lines including SQL). Both migrations are small and additive — no existing schema changes.

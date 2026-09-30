---
name: Member import tenant scoping
description: The member importer has two parallel code paths; tenant changes must be mirrored in both, and lookups must be tenant-scoped.
---

# Member import tenant scoping

Bulk member import (`/importmanager` → `POST /api/imports/execute`) has **two
independent insert paths**, and any tenant-related change must be applied to
**both** or rows silently diverge:

1. **SQL fast path** — Postgres function `process_member_import_batch(JSONB, UUID)`
   (source: `supabase/functions/import_members.sql`). Used for member imports
   keyed on email. Lives in source as a `.sql` file and must be applied to the
   live DB via the pooler (`scripts/apply-import-members-function.mjs`), since the
   Supabase direct host is IPv6-only / unreachable from this workspace.
2. **JS fallback path** — builds each row from column mappings in
   `api/imports/execute.js` (also used for organization imports).

**Rule:** every inserted row must be stamped with the importing tenant
(`importTenantId`, resolved from the session member), and every "does this row
already exist?" lookup (existing members, roles, organizations, notes-by-email)
must be scoped to that tenant.

**Why:** member email uniqueness is **per-tenant** — `UNIQUE (email, tenant_id)`
plus CI unique index `(tenant_id, lower(trim(email)))`. A global dup lookup would
let an import silently update *another* tenant's member who shares an email. And
omitting `tenant_id` on insert creates tenant-less members invisible to every
tenant-scoped view (the original bug that produced 4,162 orphans on BNMS).

**How to apply:** if `importTenantId` can't be resolved, hard-fail the import
(both members and organizations are tenant-scoped) rather than create orphans.
Roles and organizations are all tenant-scoped (no global rows), so scope those
lookups with `= tenant_id`. Repair of orphaned rows: `scripts/backfill-import-tenant.mjs`
(dry-run default, `--apply`, `--tenant=` default bnms; skips emails already
present in the target tenant and in-set duplicate emails).

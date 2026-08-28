---
name: Workspace DB targets (SUPABASE_URL vs DEST)
description: Which Supabase project the runtime vs migrations actually use, and where group-feature migrations must land.
---

# Workspace DB targets

In this Replit workspace the runtime `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`
(read by `api/_lib/database.js` → `export const supabase`) point at the **legacy
SOURCE** project (`zkvgzcruhn…`, == `SOURCE_SUPABASE_URL`), NOT the multi-tenant
prod DB. The SOURCE DB is stale: it lacks `member_group.projects_enabled` /
`events_enabled`, so group Projects/Events/Forum features cannot be exercised
against the dev preview here.

**Production** (Vercel) sets `SUPABASE_URL` to the **DEST** project
(`lvmzliem…`, `DEST_SUPABASE_URL` / `DEST_DATABASE_URL`). That is the real prod DB.

**Why:** the dev workspace and prod resolve `SUPABASE_URL` to different projects;
the running dev app talks to the legacy snapshot.

**How to apply:** schema migrations for active features (e.g. member-group
projects/events/forum toggles) go to **DEST only**, via the pooler
(`DEST_DATABASE_URL`) using the matching `scripts/apply-*.mjs` runner. Do not
pollute the SOURCE DB. To test a helper that imports the module-level `supabase`
against the real schema, run the node process with
`SUPABASE_URL=$DEST_SUPABASE_URL SUPABASE_SERVICE_KEY=$DEST_SUPABASE_KEY`.

The DEST direct Postgres hostname may resolve only to IPv6, which is not
reachable from every workspace runner, and a guessed Supabase pooler endpoint
may reject the stored direct-connection credential. Verify SQL connectivity
before relying on a transactional runner. The DEST REST service-role path
remains usable for exact reads/writes, but separate REST requests are not one
database transaction. Related bulk inserts must use deterministic identities
and explicitly support every reachable interruption state; when each request is
itself atomic, a rerun can safely resume at the next missing batch.

**Why:** a destination recovery encountered an IPv6-only direct host, no
installed arbitrary-SQL RPC, and an unusable pooler credential despite healthy
service-role REST access.

**Member-auth E2E is impossible in this workspace:** `getSessionMember`
selects `member` with an embedded `organization:organization_id(tenant_id)`
join, and the SOURCE DB's `organization` table has no `tenant_id` column —
the join errors at plan time, so every member session resolves to null (logged
as "Member not found in database", session deleted). Any member-authenticated
endpoint (member AI ask/history, etc.) can only be exercised end-to-end on the
Vercel preview (`dev.iconn.app`), never locally. Verify locally via: routing
(401 not 404), direct table CRUD against DEST with supabase-js, and code
parity with an existing member endpoint.

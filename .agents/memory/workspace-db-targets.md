---
name: Workspace DB targets (SUPABASE_URL vs DEST)
description: Which Supabase project the runtime vs migrations actually use, and where group-feature migrations must land.
---

# Workspace DB targets

MCP callback availability and project discovery are not reliable measures of destination database access.

**Why:** A task agent reported an undefined Supabase callback before reaching the provider, while the main agent could invoke the discovered callback. Project listing omitted the documented destination, but a read-only query using its verified project ID succeeded.

**How to apply:** Discover the current MCP callback names in the main agent and test a bounded read against the destination documented in `replit.md` before requesting reconnection. Do not infer revoked access from a callback ReferenceError or incomplete project listing.

The Supabase MCP SQL callback can enforce read-only transactions even when its migration callback permits schema changes.

**Why:** An explicitly approved cleanup failed with SQLSTATE `25006` at `SELECT FOR UPDATE`; the existing pinned destination connection supported the authorized transaction.

**How to apply:** Use MCP SQL for reads. For explicitly authorized data changes, use the documented destination-only connection with target validation, verified TLS, and transactional scope checks; do not route data cleanup through the migration callback.

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

The Secrets inventory is not a complete inventory of runtime-injected variables.

**Why:** The secret-existence check has reported `DEST_DATABASE_URL` absent while destination migration and validation processes could use it successfully. Treating that inventory result as proof of missing runtime access unnecessarily blocks migration work.

**How to apply:** Before requesting credentials, use the existing destination-only runner or a read-only connection check that never prints connection values. Never substitute SOURCE or the generic database URL.

Destination SQL TLS may require the public Supabase root CA rather than the container's default trust store.

**Why:** The destination pooler has produced `SELF_SIGNED_CERT_IN_CHAIN` with ordinary verified TLS; verification succeeds with Supabase's published CA. Disabling certificate verification is unnecessary.

**How to apply:** Supply the trusted provider CA while retaining certificate and hostname verification, and independently pin the REST project and SQL pooler project identity for live data runners.

**Member-auth E2E is impossible in this workspace:** `getSessionMember`
selects `member` with an embedded `organization:organization_id(tenant_id)`
join, and the SOURCE DB's `organization` table has no `tenant_id` column —
the join errors at plan time, so every member session resolves to null (logged
as "Member not found in database", session deleted). Any member-authenticated
endpoint (member AI ask/history, etc.) can only be exercised end-to-end on the
Vercel preview (`dev.iconn.app`), never locally. Verify locally via: routing
(401 not 404), direct table CRUD against DEST with supabase-js, and code
parity with an existing member endpoint.

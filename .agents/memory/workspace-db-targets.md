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

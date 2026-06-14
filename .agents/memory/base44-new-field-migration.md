---
name: base44 new field needs a DB column
description: Adding a new property to an existing base44 entity requires a DB migration; the column-per-field table does not auto-create columns.
---

The base44 generic entity API persists each entity property to its own real
column in the entity's Postgres table (e.g. `form`). It does NOT auto-create
columns for unknown properties — writes to a non-existent column silently no-op
or error depending on the path.

**Rule:** when you add a new field to an existing entity (in `schema/<Entity>.json`
and in the page's formData), you MUST also add the column via a migration in
`supabase/migrations/` and apply it. There is no schema whitelist gating the
write, but there IS the physical column requirement.

**Why:** spent investigation time confirming persistence before adding
`form.owners`; the column had to be created (`ALTER TABLE form ADD COLUMN ...
UUID[] NOT NULL DEFAULT '{}'`) before the entity save would persist it.

**How to apply:** From this workspace the Supabase direct host is IPv6-only and
unreachable; apply migrations with a `pg` client pointed at `DEST_DATABASE_URL`
(IPv4 pooler) via a `scripts/apply-*.mjs` runner, then verify by selecting the
column back. See `replit.md` "Database connection".

---
name: Nullable JSONB migration merges
description: Why idempotent configuration migrations must normalize nullable JSONB values before inspecting or extending them.
---

When an existing JSONB configuration column is nullable, always apply key-presence checks and merge operators to `COALESCE(column, '{}'::jsonb)`.

**Why:** PostgreSQL JSONB operators preserve SQL `NULL`: both `NULL ? 'key'` and `NULL || '{"key":"value"}'::jsonb` evaluate to `NULL`. An otherwise idempotent migration can therefore report success while leaving an older row unconfigured.

**How to apply:** Use the coalesced expression in both the predicate that decides whether an update is needed and the value being merged. Verify the resulting nested configuration inside a transaction before committing the migration.
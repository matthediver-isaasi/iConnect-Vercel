---
name: PL/pgSQL trigger row JSON pitfalls
description: to_jsonb(NEW) nulls, generated columns in BEFORE triggers, shared guards and CASE inside IF conditions.
---
- `to_jsonb(NEW)->'col'` for a SQL NULL column is JSON `null`, not SQL NULL; `IS NOT NULL` is then true. Wrap with `nullif(..., 'null'::jsonb)`.
- Stored generated columns are NULL in BEFORE-trigger `NEW`; exclude them from OLD/NEW whole-row comparisons (compare their inputs instead).
- A guard function shared by two tables must nest table-specific field access (`IF TG_TABLE_NAME=... THEN IF OLD.col ...`); PL/pgSQL fails "record has no field" otherwise.
- An unparenthesised `CASE ... THEN ... END` inside an `IF` condition gives "syntax error at end of input"; parenthesise it.
**Why:** all four shipped unnoticed in a migration until a local-Postgres execution test ran the triggers; install-only checks did not catch them.
**How to apply:** for any trigger reading jsonb rows, run a local Postgres test that exercises inserts and updates, not just installation.

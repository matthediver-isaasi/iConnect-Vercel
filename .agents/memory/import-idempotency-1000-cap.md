---
name: Import idempotency & the PostgREST 1000-row cap
description: Why one-off resource import scripts can silently create duplicates on re-run for large tenants.
---

The BNMS resource import scripts (`scripts/import-bnms-*.mjs`) claim idempotency by loading all existing `resource` rows for the tenant, indexing them by `target_url` (and `title` fallback), and choosing insert-vs-update per source row.

**The bug:** a single `supabase.from('resource').select(...).eq('tenant_id', T)` returns at most 1000 rows (PostgREST hard cap). Tenants that already exceed 1000 resources (BNMS had ~1448) get a truncated match set, so many just-inserted rows look absent on re-run and get **re-inserted as duplicates**.

**The fix (applied in `scripts/import-bnms-spring-meeting-2026-resources.mjs`):** page the existing-rows fetch with `.order('id').range(from, from+999)` in a loop until a short page returns. Confirm idempotency by re-running `--dry-run` — it must report `0 insert, N update`.

**Why:** the earlier scripts predate the tenant crossing 1000 rows, so the cap never bit them. It bites now.

**How to apply:** any script/endpoint that fetches a full per-tenant list to dedupe/diff must paginate (or use count + ranged pages), never a single unpaged select. Same class of bug as the list-pages preference-value cap.

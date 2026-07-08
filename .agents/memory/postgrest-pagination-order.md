---
name: PostgREST range pagination needs ORDER BY
description: Paginating supabase-js .range() without a stable ORDER BY silently skips/repeats rows
---

**Rule:** Any loop that pages through PostgREST results with `.range(from, to)` MUST include `.order(<unique column>)` (e.g. `id`). Without it, page boundaries are nondeterministic — successive requests can return overlapping or disjoint row sets, so the collected total silently varies run to run (observed: same query yielding 525 → 54 → 10 rows across three runs).

**Why:** Postgres gives no ordering guarantee without ORDER BY; each ranged request is a fresh query, so rows shuffle between pages. The failure is silent — no error, just missing data.

**How to apply:** In any `fetchAll`-style helper, bake the ordering into the helper itself (default `order('id')`) rather than trusting call sites. Secondary `.order()` calls compose fine with an existing one. Related: PostgREST also caps un-ranged selects at 1000 rows (see import-idempotency-1000-cap.md).

---
name: Resource category & subcategory role access
description: How per-role resource category/subcategory hiding works and every surface that must stay in sync
---

Model (resource_category columns, both admin-only write via the atomic RPCs behind /api/resources/category-role-access):
- `excluded_role_ids` (jsonb array): roles that cannot see the whole category. Non-empty = member-only (hidden from guests and roleless members too).
- `subcategory_excluded_role_ids` (jsonb map sub-name → role ids): hides ONE subcategory occurrence within an otherwise-visible category. Same member-only semantics. Empty map = no behaviour change (no data migration needed).

Rules (all in `api/_lib/resourceCategoryAccess.js` — always go through it):
- Hidden-subcategory set is name-level with visible-wins: a duplicate name across categories stays visible if ANY occurrence is visible.
- A resource is hidden only when it has ≥1 subcategory and ALL of them are hidden; unmapped/legacy names stay visible.
- Admin/resource-manager (`content.resource-management`) bypasses everything.

Surfaces that must all use the shared helper (miss one and it leaks): entity list + by-id (`api/entities/[entity]/*`), `/api/resources/visible-categories`, `api/public/resources.js`, `api/public/resource-categories.js`, `api/public/resource/[identifier].js`, member-AI ask. Non-admin responses must strip both fields AND trim hidden names out of `subcategories` (`stripCategoryAccessFields` + `filterCategorySubcategoriesForViewer`).

**Why:** retrieval/response filtering IS the security boundary; the client only gets names of hidden subcategories, never the role lists.

Consistency: renames go through the `renameResourceSubcategory` function (carries map keys over, merging on collision); removing a subcategory via entity PATCH prunes its map entry server-side. `fetchCategoriesWithAccess` degrades via 42703 drop-and-retry on stale DBs (feature inert there). Note `resource_category.subcategories` is a Postgres `text[]`, not jsonb.

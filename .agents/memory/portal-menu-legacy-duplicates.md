---
name: portal_menu legacy duplicates
description: How duplicate nav items arise from base44-era orphaned portal_menu rows and how to dedupe safely.
---

# portal_menu legacy duplicates (orphaned base44 parents)

Tenants migrated from base44 can carry duplicate `portal_menu` rows: the same
(section, url) page appears twice. The stale copy typically has a legacy
`feature_id` (e.g. `page_admin_<Page>`, which aliases to the canonical id via
`client/src/lib/roleAccessMap.ts`) AND a `parent_id` pointing at a 24-hex
base44 id that no longer exists as a portal_menu row (orphaned parent). The
canonical copy uses the modern `feature_id` and sits under a real uuid parent
alongside its siblings. Both being `is_active` renders the item twice in nav.

**Dedupe:** `scripts/dedupe-portal-menu.mjs` (dry-run by default; `--apply`,
`--tenant=<uuid|slug>`, `--all-tenants`, `--url=<page>` to scope one page).
Keeper preference: valid (non-orphaned) parent > non-legacy feature_id >
active; never deletes a row that has child rows.

**Why:** GFI (`fd82da65-aab7-4a5c-85b8-b2febeb2003d`) had ~13 such duplicate
rows across ~12 pages. Task #2106 only cleaned the Member Group Assignment
Report; the rest remain until a broader cleanup is run.

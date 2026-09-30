---
name: Microsite path-prefix surfaces
description: What must stay in lockstep when pages/nav rows carry a microsite_id and are served at /{prefix}/{slug}
---

Microsites (task topic: tenant microsites) give a subset of `i_edit_page` / `navigation_item` rows a `microsite_id`; those rows are served ONLY under `/{path_prefix}/{slug}` with merged chrome.

**Rule:** a row with `microsite_id` must be excluded from every default-site surface, and included only via the prefixed path. The surfaces that must agree:
- public page-by-slug endpoint (bare slug → 404 for microsite pages; `?microsite=` scopes)
- public navigation-items + tenant-branding (`?microsite=` merge; default excludes microsite rows)
- admin NavigationManagement list (filters `!item.microsite_id`)
- SSR meta (`entityMeta.js`: two-segment match before single-segment CMS match; bare-slug resolve returns null for microsite pages)
- sitemap (prefixed URLs; skip pages of inactive/unknown microsites)

**Why:** miss one surface and a "microsite-only" page leaks into the default site (or vice versa) — same failure mode as group-scoped entities.

**How to apply:**
- Chrome merge is per-top-level-key via `mergeMicrositeConfig` (empty ''/[]/{}/null falls back to tenant).
- All reads must tolerate 42P01/42703 (`isMissingMicrositeSchema`) — the workspace runtime DB is the legacy snapshot without the schema, so end-to-end microsite rendering can only be verified on preview/prod.
- Deleting a microsite unassigns pages but DELETES its nav rows (deliberate: orphaned nav rows would pollute tenant nav).

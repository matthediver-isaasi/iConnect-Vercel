---
name: RBAC map-driven parent resolution
description: Role exclusion parent lookups must come from ROLE_ACCESS_MAP nesting, never dot-prefix splitting.
---

Many RBAC resource ids nest under parents whose id does NOT match their dot-prefix (e.g. feature `content.guest-writers` under page `content.articles`, page `admin.canvas-links-manager` under module `site-builder`, page `dashboard.view` + `dashboard.*` widget features under module `system`).

**Rule:** any code reasoning about parent/child exclusion (reads, sibling expansion, section counts, server gating) must resolve parents via the real map nesting — client: `getRoleAccessHierarchy()` / map-driven `getModuleForResource`/`getPageForResource`/`isModuleId`/`isPageId` in `roleAccessMap.ts`; server: `api/_lib/roleAccessHierarchy.generated.js` (regen with `npx tsx scripts/generate-role-access-hierarchy.mjs`). Dot-prefix splitting is only a fallback for ids absent from the map.

**Why:** exclusion writes walked the nested map (deleting child entries when a parent is blocked) while reads derived parents by prefix — blocking a section flipped mismatched child toggles off→on and left keys active at runtime.

**How to apply:** after editing ROLE_ACCESS_MAP, re-run the generator; a drift test in `roleAccessMap.test.ts` fails otherwise. Never hand-roll `featureKey.split('.')` exclusion checks — import `isResourceExcluded` from the shared lib (client or `api/_lib/roleVisibility.js`).

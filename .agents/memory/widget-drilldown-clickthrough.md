---
name: Dashboard widget click-through (drilldown)
description: How widget bucket → CRM list click-through works and its transport/enforcement pitfalls
---

# Widget click-through to CRM lists

Flow: widget bar/slice/legend/list-row click → POST `/api/dashboard/widgets/:id/drilldown` `{key}` (re-runs aggregation with row-id collection, cap 2000) → ids stored in sessionStorage under `widget-drill:<nonce>` → navigate to `/organisations|/members?widgetDrill=<nonce>` → list page hook reads nonce and filters.

**Rules learned:**
- **Large id lists must never travel in a URL.** 2000 UUIDs ≈ 74KB, over proxy limits. The paginated CRM endpoints accept POST with `{ids}` in the JSON body for the drill case only; everything else stays in the query string. Express JSON body limit is the default 100kb — raise it before raising the id cap.
- **Toggle semantics must be enforced server-side**: drilldown rejects widgets whose config doesn't have `clickThrough === true`; UI gating alone isn't enough.
- **Recharts click payload shape varies** — resolve the bucket key via `entry.key ?? entry.payload?.key ?? entry.name`, never `entry.key` alone (bar/pie clicks silently no-op otherwise).

**Why:** all three were architect-review findings on the first implementation.

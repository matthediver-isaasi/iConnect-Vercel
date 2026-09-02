---
name: Reusable Canvas footer fallback
description: Source and fallback semantics for reusable Canvas footer assignments.
---

Footer source selection is explicit and legacy configuration remains stored when switching modes. A microsite in inherit mode must use the main site's configured footer unchanged, not merge in its retained microsite override. A microsite in configured mode uses its retained override, and an unavailable Canvas selection falls back to the effective configured footer. Tenant and microsite reads must retry without the optional Canvas-footer columns when PostgreSQL reports those specific columns as missing.

**Why:** Retaining dormant configuration makes mode switching reversible, but blindly merging it would make “inherit” render a stale microsite override and violate the admin's explicit choice. Preview environments can temporarily run application code ahead of the reusable-footer migration; selecting the new columns before resolving the tenant otherwise makes the entire site appear tenantless and hides a valid configured footer.

**How to apply:** Any public, SSR, preview, or editor path resolving footer chrome must interpret the source mode before merging configuration and must validate Canvas ownership before returning a design. Schema fallback must be narrow: retry only for PostgreSQL `42703` naming `footer_source` or `canvas_footer_id`; do not hide unrelated database failures.
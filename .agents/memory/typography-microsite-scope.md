---
name: Typography styles microsite scoping
description: How Typography Styles are scoped to main-site vs a single microsite, and the effective-default fallback rule.
---

A `typography_style` row belongs to exactly ONE scope: main site (`microsite_id IS NULL`) OR a single microsite (`microsite_id` set). This mirrors Canvas button-styles/swatches scoping.

**Effective default per style_type (public rendering):** microsite default ?? main-site default. A microsite page sees main-site styles PLUS its own microsite styles; for each style_type the default is the microsite's own default if it has one, otherwise the main-site default. This guarantees no broken/unstyled blocks. Central resolver: `api/_lib/typographyScope.js` `resolveScopedTypographyStyles(allStyles, micrositeId)` — used by BOTH the public endpoint (`api/public/typography-styles.js?microsite=<prefix>`) and SSR (`api/_lib/renderHtml.js` `fetchTypographyStylesForTenant`).

**`is_default` uniqueness is APP-LEVEL only** (no DB constraint) — unique per (scope, style_type). Every default-unset in `InstalledFonts.jsx` handlers must match style_type AND same scope `(s.microsite_id||null)===target`.

**Why app-level:** matches existing Canvas button/swatch pattern; a DB partial-unique across NULLable microsite_id is awkward and the refs don't use one.

**How to apply:** adding a scoped-per-microsite entity → carry `microsite_id` through create/duplicate (duplicate keeps SOURCE scope), scope the default-unset query, and make public read paths resolve via the shared resolver so the fallback default holds. Entity API POST spreads req.body unwhitelisted + SELECT *, so a new nullable column round-trips without endpoint changes.

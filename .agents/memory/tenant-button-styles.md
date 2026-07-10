---
name: Tenant button-style reuse
description: Where tenant Primary/Secondary button styling lives and how to reuse it on new surfaces.
---

Tenant button styles (`branding_config.button_styles.primary|secondary`, edited in the Button Style Creator at `/admin/branding`) are resolved by shared pure helpers in `client/src/lib/tenantButtonStyle.js`: `resolveTenantButtonStyle(variant, branding)`, `bgCssFromConfig`, `isTenantButtonVariant`, `TENANT_BUTTON_DEFAULT_SIZE`, `buildTenantButtonInlineStyle`. The Canvas block registry imports these (don't redefine them there).

For non-Canvas CTAs, use `client/src/components/common/TenantCtaButton.jsx`. It reads branding via `useTenantBranding`, applies the Primary style as inline styles with hover, and falls back to the caller's hardcoded look (`fallbackClassName`/`fallbackVariant`) when no Primary style is configured.

**Why:** styling logic used to live privately in the Canvas registry; content-card CTAs (resource/event/news/article/campaign cards) now reuse it so brand styling stays consistent everywhere from one source.

**How to apply:** when branding a new prominent CTA, reuse `TenantCtaButton` (or the helpers) rather than re-deriving the gradient/hover/border resolver. Keep iEdit and Canvas/page-builder per-element buttons OUT of this — they have their own styling.

## Custom (free-form) button styles

Beyond primary/secondary, tenants add free-form named styles on `/ButtonElements` (`ButtonElements.jsx`), stored under the same `branding_config.button_styles` map keyed by an immutable slugified `key`. Unlike `header_config.secondaryBar` (which is rebuilt from a whitelist), **`button_styles` is stored VERBATIM** by `api/admin/tenant-branding.js` (top-level shallow deep-merge only) — so new per-entry fields (e.g. `microsites`) pass through without any server whitelist change.

**Rename-focus rule:** custom-style rows must be React-keyed by a UI-only stable `uid`, never by the mutable `key`. New rows re-slugify `key` from the label on each keystroke; keying the list by `key` remounts the row and the rename input loses focus after one char. Target update/rename/delete by `uid`, strip `uid`/`isNew` on save.

**Microsite scoping is picker-only, never render.** Each custom entry carries a `microsites` array of microsite id strings (`[]` = main-site). The Canvas inspector variant pickers enumerate styles via the shared `useCustomButtonStyleEntries()` hook in `registry.jsx`, which filters by the page's `micrositeId` (from `useCanvasEditorPage()`): microsite page → styles assigned to it; main-site page → unassigned only. Primary/Secondary always offered. **Never filter the render path** (`resolveTenantButtonStyle` resolves by stored key), so already-built pages keep rendering a style even if the current page's picker no longer offers it.

## Label typography baked into a button style

A button-style config can carry `labelTypographyStyleId` (a saved TypographyStyle id) so any Canvas Button block using that tenant variant auto-renders its label in that typography. **Precedence in the shared `ButtonRender` (registry.jsx): per-block `content.typographyStyleId` > button style's `labelTypographyStyleId` > none.** ButtonRender is shared editor+public, so wiring precedence there covers both. The inspector's empty label-typography option surfaces the inherited style name via `TypographyStyleField`'s optional `noneLabel` prop.

**Why:** tenants wanted brand type on buttons without setting it per-button. Stored inside `button_styles` (verbatim passthrough) so no schema/backend change.

**How to apply:** any new surface that renders a tenant button variant should mirror this precedence. Content-card CTAs use a SEPARATE `ctaLabelTypographyStyleId` and did NOT inherit the style's `labelTypographyStyleId` as of this change (that's the open follow-up).

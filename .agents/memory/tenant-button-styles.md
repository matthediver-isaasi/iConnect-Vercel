---
name: Tenant button-style reuse
description: Where tenant Primary/Secondary button styling lives and how to reuse it on new surfaces.
---

Tenant button styles (`branding_config.button_styles.primary|secondary`, edited in the Button Style Creator at `/admin/branding`) are resolved by shared pure helpers in `client/src/lib/tenantButtonStyle.js`: `resolveTenantButtonStyle(variant, branding)`, `bgCssFromConfig`, `isTenantButtonVariant`, `TENANT_BUTTON_DEFAULT_SIZE`, `buildTenantButtonInlineStyle`. The Canvas block registry imports these (don't redefine them there).

For non-Canvas CTAs, use `client/src/components/common/TenantCtaButton.jsx`. It reads branding via `useTenantBranding`, applies the Primary style as inline styles with hover, and falls back to the caller's hardcoded look (`fallbackClassName`/`fallbackVariant`) when no Primary style is configured.

**Why:** styling logic used to live privately in the Canvas registry; content-card CTAs (resource/event/news/article/campaign cards) now reuse it so brand styling stays consistent everywhere from one source.

**How to apply:** when branding a new prominent CTA, reuse `TenantCtaButton` (or the helpers) rather than re-deriving the gradient/hover/border resolver. Keep iEdit and Canvas/page-builder per-element buttons OUT of this — they have their own styling.

---
name: Per-tenant installable fonts
description: How the installed_font system replaced the hardcoded curated font list, and every surface that must load/consume it.
---

# Per-tenant installable fonts

The old hardcoded curated font list (`client/src/lib/sharedFonts.js` `CURATED_FONTS`) is now
a per-tenant `installed_font` table. `CURATED_FONTS` survives only as the fallback used
when no tenant resolves (loading / dev host / fetch failure).

**Pitfall (hooks):** every React component that renders a font dropdown must call
`useInstalledFonts()` in ITS OWN body. `IEditImagePanelElement.jsx` has two components
(default render + `...Editor`) and both need the hook; sharing one call across them throws
a ReferenceError at render.

**Rule:** any font-family dropdown, preview, or page-render must source fonts dynamically,
not from `CURATED_FONTS` directly.
- Client dropdowns: call `useInstalledFonts()` from `client/src/lib/installedFonts.js` and
  use its `options` (already falls back to curated defaults). Consumers wired: InstalledFonts
  typography editor, `brandingShared.jsx` SecondaryBarControls, `AdminBranding.jsx` (3 nav
  font selects), `IEditImagePanelElement.jsx`.
- Page loading: `InstalledFontsLoader` in Layout/PublicLayout/BarePublicLayout + SSR injection
  in `renderHtml.js`. Base fonts (Poppins, Degular) stay hardcoded in the layouts.
- After an admin add/remove, call `clearInstalledFontsCache()` so the module-level fetch cache
  in installedFonts.js is busted and other surfaces refetch on next mount.

**Removal is guarded server-side** in `api/entities/[entity]/[id].js` DELETE: returns 409 if
`is_base`, or if the font's `font_stack` is referenced by any typography_style.font_family,
tenant header_config nav font, branding basePortalFont, or any microsite header_config. The
base44 client throws `Error("API Error (409): <msg>")`; strip that prefix to show the guard
message.

**Why:** fonts are chosen in many places; a stale hardcoded list meant admins couldn't add/remove
fonts and new fonts wouldn't render on public/SSR pages. The 409 guard prevents removing a font
that would break existing styling.

**Store shape:** `font_stack` is the CSS value (quote multi-word names, append generic family —
see `buildFontStack`); `google_family` uses '+' for spaces (see `googleFamilyToken`).

**Live browse search:** the add-font "browse" picker searches the full Google Fonts catalogue
via `api/public/google-fonts.js`, which proxies the Google Fonts Developer API (needs
`GOOGLE_FONTS_API_KEY`, kept server-side; caches the popularity-sorted catalogue in module
scope). The endpoint always returns 200 with a `fallback` flag — true when the key is missing or
upstream fails — so the client drops back to the curated `POPULAR_GOOGLE_FONTS` list. `category`
from Google maps 1:1 onto `buildFontStack`'s generic-family choice.
**Why:** admins needed to add any font, not just the curated shortlist, without leaking the key.

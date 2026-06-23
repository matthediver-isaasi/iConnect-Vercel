---
name: Cross-origin CSS mask-image is unreliable
description: A cross-origin URL in CSS mask-image often won't apply (paints a solid coloured square); inline a same-origin base64 data URI, fetching via the /api/og-image proxy for Cloudflare-fronted asset hosts.
---

# Cross-origin `mask-image` paints a solid square

When recolouring an uploaded SVG silhouette via CSS `mask-image` + a
`background-color`, do NOT point `mask-image` at a cross-origin URL (asset on
`vault.iconn.app` / `*.supabase.co` while the page is on a tenant domain).
Browsers frequently refuse to apply a cross-origin image as a mask, so the mask
is dropped and the whole box renders as a solid block of `background-color`
(a "coloured square"). Inline a same-origin `data:` URI instead.

**The recolour technique itself is sound for stroke-based icons too.** Verified
empirically (Chrome): an inlined data URI of a lucide-style outline SVG
(`fill="none" stroke="currentColor"`) masks correctly — raw `;utf8,`, base64,
and plain percent-encoded all render the icon, NOT a square. So a reported
square is almost never the mask technique; it's the SVG not getting inlined.

**The real fragile link is the fetch, not the mask.** `vault.iconn.app` sits
behind Cloudflare bot management, so a plain browser `fetch()` of the SVG can be
challenged/blocked or return an HTML challenge page (rejected by content-type),
leaving the icon un-inlined. `*.supabase.co` usually does send CORS and fetches
directly, but don't rely on it.

**How to apply:** in `client/src/hooks/useResolvedSocialIcons.js`, fetch
cross-origin asset-host URLs through the same-origin `/api/og-image` proxy
(server fetches bytes cleanly, no Cloudflare/CORS), with a direct-fetch
fallback, then inline as a **base64** `data:image/svg+xml;base64,<...>` URI
(broadest cross-browser mask reliability) and use that as `mask-image`. Proxy is
SSRF-guarded to exactly these hosts (`api/og-image.js`). Consumed by
`PublicHeader.jsx`, `PublicLayout.jsx`, and `AdminBranding.jsx`.

**Deployment caveat:** tenants don't resolve in the Replit workspace, and the
live site (dev.iconn.app/prod) only updates after the commit lands on the
`selfserve2` branch and Vercel rebuilds — so a "still broken" report can simply
be undeployed code. Verify mask logic via a standalone served HTML test page.

Separately, an SVG with an opaque/filled background legitimately masks to a
square — that's a content problem (guide admins to upload transparent SVGs).

---
name: Recoloured social icon renders as a solid square
description: A CSS mask-image recoloured SVG that paints as a solid coloured square is almost always a MALFORMED svg (truncated upload), not the mask technique or cross-origin fetch.
---

# Recoloured SVG icon paints a solid square

Recolouring an uploaded SVG silhouette via CSS `mask-image` + `background-color`
is sound — including for stroke-based lucide-style icons
(`fill="none" stroke="currentColor"`). Verified empirically in Chromium: a
**complete** inlined `data:image/svg+xml;base64,<...>` masks correctly (raw
`;utf8,`, base64, and cross-origin all render the icon). So a reported square is
almost never the mask technique or the fetch path.

**The real cause was a MALFORMED SVG: the stored file was truncated by its last
bytes** — `</svg>\n` became `</svg` (missing the closing `>`). A browser's strict
SVG-*image* parser (used for `mask-image`) rejects malformed markup, so the mask
resolves to nothing and the box paints as a solid block of `background-color`.
The lenient HTML parser tolerates the same bytes, which is why a raw inline
`<svg>` rendered fine while the mask did not — a misleading symptom.

**Why the file was truncated:** the hand-rolled multipart parser in
`api/integrations/upload-file.js` double-stripped the part's trailing bytes. The
parts loop already removes the framing `\r\n` (via `slice(start, idx - 2)`), then
the file branch stripped two MORE bytes (`content.slice(0, content.length - 2)`),
silently chopping the last 2 real bytes of EVERY upload. Fix: use `content`
directly. This affected all uploads through that endpoint, not just SVGs.

**How to diagnose a "coloured square" recolour bug:**
1. `od -c` / hexdump the actual stored bytes and check the file ENDS in `</svg>`.
   Compare `Content-Length` header to downloaded byte count.
2. Render the raw stored bytes vs a repaired copy as masks on a standalone served
   HTML page and screenshot — a valid SVG masks, a truncated one squares.
3. Only after ruling out malformed content, suspect fetch/CORS/cross-origin.

**Repair already-stored truncated files at render time:** in
`client/src/hooks/useResolvedSocialIcons.js` (`toBase64DataUri`), after stripping
prologue + trim, if the markup ends in `</svg` without `>`, append `>` before
base64-encoding. This fixes existing icons across all tenants without a storage
migration. Consumed by `PublicHeader.jsx`, `PublicLayout.jsx`, `AdminBranding.jsx`.

**Deployment caveat:** tenants don't resolve in the Replit workspace, and the
live site (dev.iconn.app/prod) only updates after the commit lands on the
`selfserve2` branch and Vercel rebuilds — a "still broken" report can be
undeployed code. Verify via a standalone served HTML test page.

Separately, an SVG with an opaque/filled background legitimately masks to a
square — that's a content problem (guide admins to upload transparent SVGs).

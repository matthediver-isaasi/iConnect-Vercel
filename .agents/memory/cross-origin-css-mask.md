---
name: Cross-origin CSS mask-image is unreliable
description: A cross-origin URL in CSS mask-image often won't apply, painting the element as a solid coloured square; inline a same-origin data URI instead.
---

# Cross-origin `mask-image` paints a solid square

When recolouring an uploaded SVG silhouette via CSS `mask-image` + a
`background-color`, do NOT point `mask-image` at a cross-origin URL (e.g. an
asset on `vault.iconn.app` / supabase storage while the page is on a tenant
domain). Browsers frequently refuse to apply a cross-origin image as a mask even
when the asset sends `access-control-allow-origin: *`. The result is the mask is
ignored and the whole box renders as a solid block of `background-color` (a
"coloured square") — or, in some engines, fully transparent/invisible.

**Why:** mask compositing needs the image's pixel data; cross-origin image
references for masking are treated as tainted/invalid in practice, so the mask
layer is dropped.

**How to apply:** fetch the SVG (`fetch()` works — these assets do send CORS
headers) and inline it as a same-origin `data:image/svg+xml;utf8,<encoded>` URI,
then use that as `mask-image`. A same-origin data URI masks reliably in every
browser. Shared implementation: `client/src/hooks/useResolvedSocialIcons.js`,
consumed by `PublicHeader.jsx`, `PublicLayout.jsx`, and `AdminBranding.jsx` for
the custom social-icon glyphs. Separately, an SVG with an opaque/filled
background legitimately masks to a square — that's a content problem, not a code
one (guide admins to upload transparent SVGs).

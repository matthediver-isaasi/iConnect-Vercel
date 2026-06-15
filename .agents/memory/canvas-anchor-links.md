---
name: Canvas anchor links / link-field surfaces
description: How in-page anchor links work in /canvasbuilder and the many link fields that must share one anchor source.
---

# Canvas Builder anchor links

A block's `anchorId` (URL-safe slug) is emitted as the wrapper element's real
HTML `id` ONLY in `CanvasPageRenderer` (public + editor preview iframe), NOT in
the live-editing `CanvasStage` — deliberately, so the editor surface never gets
duplicate ids that collide with editor chrome.

**Why:** the editor preview is a separate document (iframe), so ids there are
isolated; the drag-drop stage shares the editor's document and must stay id-free.

## Link-field surfaces (the "wire through N places" trap)
"Pick an anchor" had to be added to EVERY link editor, which are scattered across
per-block Inspector components in `blocks/registry.jsx`: button href, hero CTA,
card CTA (`ctaHref`), pricing CTA (`ctaHref`), image href, logo href, and the
mega-menu trio (item href, column-link href, featured href) — plus inline text
links via the shared `RichTextEditor`. All read one source of truth:
`CanvasAnchorContext` (`getPageAnchors` / `findDuplicateAnchorIds` from
`canvasDesign.js`), published once by `CanvasBuilder` around the inspector.

**How to apply:** when adding a new block type with a link/href field, use the
shared `LinkField` (not a plain `TextField`) so it gets the anchor picker for
free. New navigable targets won't get anchor support otherwise.

## RichTextEditor is shared with email-builder
`RichTextEditor.jsx` lives under `email-builder/` and is reused by canvas. The
anchor picker is an OPTIONAL additive `anchorOptions` prop — absent for the email
builder (no UI change), present (from context) for canvas text blocks.

## Smooth-scroll
`useAnchorSmoothScroll` in `CanvasPageRenderer` intercepts `a[href^="#"]` clicks
to avoid an SPA route change (critical inside the preview iframe), honors
`prefers-reduced-motion`, and offsets by the tallest pinned sticky/fixed
header measured at click time. URL hash is only written via `replaceState`
outside the preview iframe.

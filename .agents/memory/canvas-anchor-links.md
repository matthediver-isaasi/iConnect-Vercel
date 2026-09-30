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
`useAnchorSmoothScroll` in `CanvasPageRenderer` intercepts in-page anchor clicks
to avoid an SPA route change (critical inside the preview iframe), honors
`prefers-reduced-motion`, and offsets by the tallest pinned sticky/fixed
header measured at click time. URL hash is only written via `replaceState`
outside the preview iframe.

## Cross-page anchors (`/slug#anchor`)
Pickers can target anchors on OTHER canvas pages, emitting `/page-slug#anchor-id`
instead of a bare `#id`. The other pages are threaded from `CanvasPageEditor`
(filtered from the existing `allPages` query: canvas builder_type + has slug +
not the current page) → `CanvasBuilder` `otherPages` prop → `CanvasAnchorProvider`
`pages` prop, which computes per-page anchors via `getPageAnchors` and exposes
them as `pages[].anchors` alongside the current page's `anchors`.

**Cross-page navigation is intentionally NOT an SPA soft-nav.** Canvas block
links are plain `<a href>` with no global interceptor, so `/other#id` does a full
browser navigation; the destination scrolls via the existing initial-`#hash`
effect on mount. The smooth-scroll click handler only short-circuits links whose
PATH equals the current `window.location.pathname` (both bare `#id` and
`/this-page#id`) — everything else falls through to navigation.

**Why:** treating `/this-page#id` as same-page avoids a wasteful full reload when
a link happens to spell out the current page's slug; cross-page links must reload
so the other page's blocks mount before the arrival scroll runs.

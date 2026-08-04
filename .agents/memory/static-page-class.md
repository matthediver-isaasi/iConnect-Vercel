---
name: Static "AI generated" page class
description: builder_type='ai_static' pages — read-only sanitized HTML/CSS; write-path and render-surface constraints.
---

A third page class exists alongside `iedit` and `canvas`: `ai_static` pages carry their whole body on the page row as sanitized HTML plus CSS scoped under the page's own wrapper attribute. There is no editor for them.

**Rules:**
- Writes funnel through a single server-side store-time sanitize+scope choke point; the entity API refuses this class's content fields and creation entirely.
- Every render surface — client slug page, home-page dispatch, SSR prerender, meta resolution — must branch on this class before any element-list fall-through, and must emit BOTH the scoped stylesheet and the scope wrapper; SSR and client output must stay byte-equivalent.

**Why:** dangerouslySetInnerHTML is only safe because of the write choke point; a missed dispatch branch or a style-less SSR path ships a blank/unstyled page (both happened during rollout).

**How to apply:** when touching page rendering, sweep every surface that branches on the page class; author static HTML with classes + `<a>` CTAs only and check the sanitiser's removal report.

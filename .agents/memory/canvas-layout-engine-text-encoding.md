---
name: Canvas layout engine text encoding (& and entities)
description: Which buildDesign() spec fields take raw HTML vs plain text, so ampersands/entities are encoded correctly.
---

In `api/_lib/canvasLayoutEngine.js` (`buildDesign`, used by
`scripts/provision-canvas-page-from-doc.mjs`), spec fields fall into two encoding
classes:

- **Raw HTML** (injected as innerHTML): the `html` passed to `text`/`feature`
  sections, column `html`, and anything built with the `P()` / `LI()` helpers.
  Here ampersands MUST be HTML-escaped: write `&amp;` (and `<`/`>` as entities).

- **Plain text** (React-rendered as a text node, or run through `escHtml` once):
  section `heading` (via `makeH2` → `escHtml`), card `heading`/`cta` (via
  `makeCard`, stored raw and React-rendered), and button `label`/`buttons[]`
  (via `makeButton`, stored raw). Here you MUST use a LITERAL `&` — writing
  `&amp;` double-encodes and the page shows the literal text "&amp;".

**Why:** a Governance page shipped with `heading: 'Professional Groups &amp; Committees'`
and `cta: 'Explore Professional Groups &amp; Committees'`; because `makeCard`
stores those raw and React escapes on render, the live card literally displayed
"&amp;". The proven-correct pattern already in the file is `heading: 'Awards & Recognition'`
(literal `&`).

**How to apply:** when a card heading/CTA, button label, or section heading
contains an ampersand, use a bare `&`. Only inside `P()`/`LI()`/`html` strings
use `&amp;`. Quick check after building: grep the built design JSON for `&amp;`
appearing in a `heading`/`ctaLabel`/`label` field — that's a bug.

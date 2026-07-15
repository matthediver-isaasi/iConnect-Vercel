---
name: Canvas blocks reusing public card components
description: How canvas list blocks stay identical to public pages and remain editor-safe when reusing a shared card component
---

# Canvas list blocks reusing shared public card components

To keep a Canvas Builder list block (e.g. resources) visually identical to its
public page and prevent drift, render the SAME card component the public page
uses (single source of truth) with the SAME props the public page passes — do
not hand-roll a parallel card in the block.

**Why:** duplicated card markup + per-block typography/CTA controls silently
drift from the public page whenever the public card changes. Reusing the real
component makes parity structural: same data source (the public client list
call), same component, same props => identical output. When you do this, delete
the block's redundant card typography / CTA inspector controls — they are now
inherited from the public card.

**Editor-safety gotcha:** public card components often navigate via JS
`onClick` (`window.open` / `location.href`), NOT via `<a href>`. The href-based
LinkField / anchor approach does not intercept them. In the builder you must
wrap each card in an element with `onClickCapture` that calls
`preventDefault()` AND `stopPropagation()` when in editor mode (`asEditor`).
`preventDefault` alone is insufficient for JS-driven navigation.

**How to apply:** when a new canvas block should mirror a public list page,
find that page's card component + the exact props it passes, replicate the
data-fetch (button styles, logged-in check) the page does, render the shared
card, and guard clicks with an `onClickCapture` stopPropagation wrapper gated
on editor mode. Bookmark/share/etc render exactly as on the public page (public
read-only form); never pass admin `onEdit`/`onDelete`.

**Mirroring a whole iEdit element (not just a card):** the same principle
scales up — a canvas block can wrap the FULL iEdit element component as its
renderer AND reuse the element's exported editor panel as the inspector
(adapt `{element, onChange}` to the canvas `{block, update}` contract:
`onChange={(el) => update((b) => ({ ...b, content: el.content }))}`). Leave
`BLOCK_DEFAULTS.content` empty when the element supplies all defaults by
destructuring. Gotcha: iEdit elements that scope responsive `<style>` rules
by `content.anchor` collide when two anchor-less blocks share a page —
override `anchor` with a per-block-id fallback in the wrapper (side effect:
a DOM id is always emitted, acceptable).

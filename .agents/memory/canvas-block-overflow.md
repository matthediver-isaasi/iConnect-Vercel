---
name: Canvas block overflow clipping
description: Why canvas dropdown/overlay UIs get clipped, and the allowOverflow opt-out flag
---

Every Canvas Builder block box clips its content with `overflow: hidden` in
BOTH renderers — the editor (CanvasStage.jsx) and the public/preview renderer
(CanvasPageRenderer.jsx). Sections are the only built-in exception
(`overflow: visible`).

**Symptom:** any block whose UI extends *outside* its own bounding box — a
dropdown panel positioned `top-full` (below the bar), a popover, a tooltip —
renders but is invisible because it's clipped. Hover/state still fires (e.g. a
chevron rotates) so it looks like "the toggle works but nothing opens."

**Fix / how to apply:** add `allowOverflow: true` to that block's REGISTRY
definition in registry.jsx. Both wrappers honor it
(`overflow: def.allowOverflow ? 'visible' : 'hidden'`; the page renderer ORs it
with `isSection`). Scope it to the one block that needs it — do NOT remove the
global clip, other blocks rely on it.

**Why:** introduced for the Mega Menu block whose dropdown opens below the bar.

**Also clips rounded corners, not just overlays:** a block whose child has its
own `border-radius` LARGER than the wrapper's default 4px (DEFAULT_STYLE.borderRadius
in canvasDesign.js) gets its corners clipped to ~4px on every surface — the wrapper's
`overflow: hidden` + its own 4px radius crop the child. This is why a tenant-styled
Button block's configured/pill radius rendered as a fixed ~5px until BUTTON got
`allowOverflow: true`. Same one-flag fix; still scope to the affected block.

**Tenant-button radius-0 gotcha (separate):** every tenant-button render path used
``${style.radius ?? 6}px`` so a configured radius of exactly `0` fell back to 6.
Use `Number.isFinite(style.radius) ? style.radius : 6`. Paths live in registry.jsx
(standalone Button, Hero CTA, card CTA, pricing-tier CTA) + the shared helper
buildTenantButtonInlineStyle in lib/tenantButtonStyle.js — keep them in lockstep.

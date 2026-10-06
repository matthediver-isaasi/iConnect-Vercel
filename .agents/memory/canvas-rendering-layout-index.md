---
name: Canvas rendering and layout
description: Index of durable Canvas V1/V2 rendering, geometry, reflow, and editor behavior rules.
---

Use the focused topic that matches the change:

- [Block overflow clipping](canvas-block-overflow.md)
- [Full-width versus full-bleed](canvas-fullwidth-vs-fullbleed.md)
- [Anchor links and link fields](canvas-anchor-links.md)
- [Read-time symbol resolution](canvas-symbol-resolution.md)
- [Card row equalization](canvas-card-row-equalization.md)
- [Layout-engine text encoding](canvas-layout-engine-text-encoding.md)
- [Public reflow collapsed baseline](canvas-reflow-collapsed-baseline.md)
- [Late font metrics](canvas-late-font-metrics.md) — readiness covers only already registered faces; isolate font-only and typography-arrival races.
- [Spatial reflow lanes](canvas-spatial-reflow-lanes.md)
- [Committing auto-height reflow](canvas-autoheight-commit.md)
- [Mobile stage clamp](canvas-mobile-stage-clamp.md)
- [Flow auto-layout model](canvas-flow-model.md)
- [Flow first paint](canvas-flow-first-paint.md)
- [V1 public grow-only boxes](canvas-box-public-growonly.md)
- [Flow builder first-section behavior](canvas-flow-builder-first-section.md)
- [Block style render surfaces](canvas-block-style-render-surfaces.md)
- [Unsaved-changes guard](canvas-unsaved-changes-guard.md)
- [Editor zoom versus reflow](canvas-editor-zoom-reflow.md)
- [Embedded breakpoints](canvas-embedded-breakpoints.md) — mobile stages retain desktop browser media queries; embedded layouts must follow element width.
- [Flow section backgrounds](canvas-flow-section-backgrounds.md)
- [Reusable footer fallback](canvas-footer-fallback.md)
- [Route-owned chrome decisions](route-owned-chrome.md)
- [Canvas dashboard embedding](canvas-dashboard-embedding.md) — reuse dashboard authorization and presentation within the authored frame.
- [Canvas preview authorization](canvas-preview-authorization.md) — positively verify editor access before returning preview content.
- [Embedded form intrinsic layout](form-embed-intrinsic-layout.md) — measure content independently of the iframe viewport; coordinate navigation and layout.
- [Positioned table overflow](positioned-table-overflow.md) — contain positioned descendants so a scroller cannot expand the document.
- [Table wrapping without geometry repair](canvas-table-wrap-geometry.md) — old no-wrap frames need read-time editor reflow, not automatic saved-height repairs.

**Why:** Canvas has parallel editor/public and V1/V2 paths. Flattening every specialized rule into the always-loaded memory index crowded out unrelated project knowledge.

**How to apply:** Open this hub before changing Canvas layout or rendering, then read only the linked topics relevant to the affected path.
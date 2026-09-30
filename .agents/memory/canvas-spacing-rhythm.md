---
name: Canvas spacing rhythm source of truth
description: Where the canonical CanvasBuilder spacing/geometry standard actually lives, and why the "reference" pages are not it.
---

# Canvas spacing rhythm source of truth

The authoritative CanvasBuilder spacing/geometry standard is the layout-engine
**constants inside `scripts/provision-canvas-page-from-doc.mjs`** (CANVAS_W,
MARGIN/CONTENT_W, COL_GAP/COL_W, hero heights + padX, gap-after-hero, band
padding/inner-top, H2 height, heading→divider, divider width/thickness,
divider→body, section gap). Newer pages are generated from these; older
hand-built pages drift from them.

**Why:** People point to named "reference" pages as the standard, but of the
three commonly cited (about-mrt, travelling-fellowships, honory-membership)
only `about-mrt` sits cleanly on the 150/900 grid. The other two are original
hand-built pages that carry their own drift (blocks at x=0/125/616), so
measuring them as "the target" is wrong. Trust the provisioning constants.

**How to apply:** For any BNMS canvas spacing analysis/normalization, derive
TARGET from the provisioning script constants, not from sampling live pages.
Reusable analysis lives in `scripts/lib/canvasSpacing.mjs`
(extractSignature/compareToTarget/classifyPage/normalizeDesign/computeReflow).
Pages using custom/dynamic blocks (symbol, wall-of-fame, form-embed,
event-carousel, pricing-table, gallery, resource-list, video, stat,
article-list, card-flip-grid) are NOT safe to auto-normalize — classify as
review. computeReflow groups blocks into rows by y within a 24px tolerance;
row objects MUST store their own y or side-by-side cards get stacked.

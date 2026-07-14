---
name: Canvas layout engine mobile stacking
description: Engine-provisioned v1 pages need explicit tablet/mobile frames; card bodies can't contain tables.
---

Two hard constraints for pages built via the doc→canvas layout engine:

1. **Engine emits desktop-only frames.** `bpOf()` leaves tablet/mobile empty, so on phones the display-only `clampGeomToStage` pulls a 2-up card's second column back to x:0 at the SAME y — the cards fully overlap (second covers first). Hand-built pages carry explicit stacked mobile frames (x:16, w:343 at 375). Fix: a stacking pass that writes explicit tablet/mobile frames single-column **in source order** (the engine emits column/card contents grouped, so source order IS reading order); keep desktop heights — the public reflow grows text/cards to content and pushes blocks below. Re-wrap the band section per breakpoint. See `stackResponsive` in the provisioning script.

2. **Card/text bodies pass through the email-builder rich-text sanitizer** (`client/src/components/email-builder/sanitize.js`) which strips `<table>` (and most layout tags). Only the `custom-html` block type allows tables. Tabular data destined for a card body must be re-expressed with allowlisted tags (p/br/strong/em/span+style).

**How to verify:** don't trust `?_bp=mobile` screenshots at a desktop viewport (breakpoint CSS is @media/viewport-based); validate the stored bp frames arithmetically (no overlap, x+w ≤ breakpoint width).

---
name: Embedded form intrinsic layout
description: Why iframe sizing and successful pagination need separate signals and shared layout ownership.
---

Measure a natural content wrapper, not the iframe document's scroll height. Keep pagination intent separate from resize notifications.

**Why:** A document's scroll height is at least its viewport height. Once a parent enlarges the iframe, document-based measurements can permanently retain that height on shorter pages. Synthetic parent shrink tests cannot detect this. Scrolling on every resize also interrupts respondents when conditions, fonts, or delayed content change.

**How to apply:** Verify grow/shrink sequences through the real iframe at desktop and mobile widths. Arm host scrolling only for a committed successful page navigation; initial mount, validation failure, conditional page clamping, and ordinary measurements are not navigation. Preserve payment-return authorization separately.

Coordinate runtime displacement at stage scope when several embeds affect the same Canvas siblings.

**Why:** Independent cleanup functions can capture and restore another embed's temporary positions, losing growth or accumulating gaps. Authored space is not runtime growth and must not be removed.

**How to apply:** Restore only owned changes, then recompute all active embed contributions from current authored/breakpoint geometry. Test interleaved grow/shrink and removal, not just one embed in isolation.
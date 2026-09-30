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

Treat picker clipping as an overlay-space problem unless measurements prove a
resize feedback loop. Keep picker space separate from payment viewport reservations.

**Why:** Real-iframe reproduction showed long menus opening above a short iframe
with negative local coordinates while the natural wrapper, iframe, and downstream
Canvas content all stayed the same height. Increasing iframe height would hide
the collision defect by adding unwanted page space. A tall iframe also overstates
usable space when most of it is outside its same-origin parent's viewport.

**How to apply:** Bound embedded pickers to the visible iframe/ancestor viewport
intersection, retain iframe-local behavior across an inaccessible origin, and use
a contained dialog when no anchored side has usable space. Keep keyboard-induced
dialog fallback latched until close to avoid focus/remount oscillation. Test actual
iframe geometry and unchanged resize reports, not body mutation counts alone.
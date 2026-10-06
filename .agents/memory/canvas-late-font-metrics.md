---
name: Canvas late font metrics
description: Font readiness does not cover later stylesheet discovery, and interactive growth is not a new baseline.
---

Treat document.fonts.ready as readiness for faces currently registered, not as
proof that asynchronous tenant font discovery or typography is finished.

**Why:** A resolved promise can precede registration entirely. A transient short
measurement then becomes permanent false growth, even after every asset loads.
Extending a timeout cannot establish correctness for arbitrarily late assets.

**How to apply:** Repair baseline identity on actual metric changes without a
global blank gate. Keep collapsed accordion measurements independent of expanded
answers; do not erase unrelated dynamic card growth on global asset completion.
Test seeded typography plus late fonts separately from asynchronous typography
because either can independently cause the initial short measurement.

A grown card's current height cannot establish its original resting height, even
when a relevant font changes. Retain the old reference conservatively once real
growth has been observed. Margin-only typography changes need a separate style
observation because ResizeObserver reports border boxes, not external margins.

**Why:** Promoting expanded content to a font-corrected baseline can remove its
push-down while leaving the content tall. Ignoring margin-only updates leaves a
stale margin-inclusive footprint despite apparently stable element dimensions.

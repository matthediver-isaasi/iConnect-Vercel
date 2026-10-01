---
name: Table wrapping without geometry repair
description: Why wrapped Canvas tables must use read-time layout rather than bake historical no-wrap frames.
---

Keep table wrapping changes render-only for saved geometry, including after an
author changes the table width. Reuse the existing render-only reflow contract
in both editor and public views, preserving the usual grow-only authored-gap
policy rather than opting tables into signed shrink.

**Why:** Old tables can have short frames from the horizontal-scrolling layout.
Ordinary editor auto-height blocks suppress read-time offsets because they
normally bake measurements after an author edit. That combination leaves newly
wrapped tables overlapping following content on first open. Relaxing the
author-intent gate would instead dirty and rewrite saved pages merely by
opening them, contrary to the no-historical-repair requirement.

**How to apply:** Treat a table's stored height as historical geometry, not an
assertion of its current content height. Exercise short historical frames,
following blocks and enclosing sections in browser tests. Keep save/reload
checks separate from measured visual height and leave the shared bake
settle/corruption guards intact for other block types.
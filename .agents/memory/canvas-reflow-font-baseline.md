---
name: Canvas public reflow font-load baseline guard
description: Why public-path collapsed baselines must stay provisional until web fonts settle
---

**Rule:** Any public-renderer layout state derived from a first-paint DOM measurement (e.g. the reflow "collapsed baseline") must treat measurements as provisional until `document.fonts.ready` + a double rAF have passed — otherwise a fallback-font render gets locked in.

**Why:** On hard refresh, mount-time useLayoutEffect measurements happen in the fallback font. Min-only baseline capture locked a too-short fallback height in forever; the real font's taller render then read as push-down growth — a permanent phantom gap below text. SPA navigation (fonts cached) never showed it, making the bug look intermittent.

**How to apply:** Use the provisional-overwrite pattern (`updateReflowBaseline` in `autoHeightBake.js`): pre-settle reports OVERWRITE (track latest), post-settle reports min-in. The settle flip must wait fonts.ready + double rAF so the font-swap ResizeObserver re-report flushes first (same contract as the editor's `useAutoHeightBake` Gate 1); include a hard timeout fallback so the gate always opens.

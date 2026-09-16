---
name: Browser geometry assertions
description: Avoid false layout regressions while dialogs are animating.
---
Wait for a dialog's opening animations to finish before comparing bounding boxes across scrolling or interaction.

**Why:** A stationary header changes position and size during the shared dialog's entrance transform; immediate geometry comparisons misidentify this as scrolling drift.

**How to apply:** Await the element's active animation promises before taking the baseline, while retaining real overflow and viewport assertions.
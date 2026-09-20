---
name: Browser geometry assertions
description: Avoid false layout regressions while dialogs are animating.
---
Wait for a dialog's opening animations to finish before comparing bounding boxes across scrolling or interaction.

**Why:** A stationary header changes position and size during the shared dialog's entrance transform; immediate geometry comparisons misidentify this as scrolling drift.

**How to apply:** Await the element's active animation promises before taking the baseline, while retaining real overflow and viewport assertions.

Scroll-to-top geometry assertions need sufficient trailing document content.

**Why:** Browsers clamp scrollTop to the document's maximum; a shorter final page can make exact top alignment physically impossible even when the correct element was targeted.

**How to apply:** For exact alignment tests, provide trailing fixture content. For short documents, assert target visibility instead of demanding an unreachable scroll position.
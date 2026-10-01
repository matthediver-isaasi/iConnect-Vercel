---
name: Canvas embedded breakpoints
description: Responsive embedded experiences must follow element width rather than the editor viewport.
---

Use container width for responsive layouts within Canvas elements; retain viewport breakpoints for standalone pages.

**Why:** The mobile Canvas stage remains inside a desktop browser document. Viewport media queries still select desktop columns, even when the authored element is only 375px wide. Zoom transforms also make visual width measurements unsuitable as breakpoint authority.

**How to apply:** Scope native inline-size container queries to the embedded experience, including nested grids and sticky/height-clamped columns. Verify narrow embeds inside wide browser viewports and resizing across breakpoints, not just mobile browser screenshots.
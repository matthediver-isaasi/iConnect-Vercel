---
name: Canvas responsive typography selectors
description: Tenant typography @media overrides must target the element carrying the inline style, never the block wrapper.
---

Responsive tenant-typography @media rules (font-size / line-height / letter-spacing / margin-bottom) MUST target the element that carries the inline desktop typography style, e.g. `[data-cb="id"] [data-tg-r="text-root"]` — never the bare `[data-cb="id"]` wrapper.

**Why:** an inline style on a child beats values inherited from the wrapper even with `!important` on the wrapper rule, and `margin-bottom` doesn't inherit at all. This bit the Text block: mobile sizes worked in the editor (inline per-breakpoint pinning) but never publicly.

**How to apply:** helpers live in the React-free `client/src/lib/canvasTypographyResponsive.js` (unit-tested via `canvasTypographyResponsive.test.mjs`, part of ai-assistant-tests). Any per-block override `<style>` that must beat these tenant rules should use the SAME element selector and rely on later source order at equal specificity (e.g. Text block's line-height/letter-spacing spacing override). New blocks: tag the styled element with a `data-tg-r` marker and build selectors through the shared helpers.

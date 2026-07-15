---
name: Tenant button-style icons (Lucide + Font Awesome)
description: How a button style's default icon field holds either a Lucide name or an FA class, and the single resolver all render surfaces must use.
---

The tenant button-style default icon lives at `style.icon = { name, size, color, position }` and `name` is polymorphic: either a Lucide icon name (legacy) or a Font Awesome class string like `fa-solid fa-star` (picked via the shared `FontAwesomeIconPicker`).

**Rule:** never resolve `icon.name` with `getLucideIcon()` directly. Always use the shared `renderStyleIcon(name, sizePx, color)` exported from the canvas block registry — it detects FA via `isFaIconName()`, sanitizes the class, and renders `<i>` sized with `fontSize` (Lucide uses width/height).

**Why:** there are several independent render surfaces (standalone Button CTA, Button block tenant fallback, Card CTA, pricing CTA, /ButtonElements previews). Any surface that resolves the name itself silently drops FA icons.

**How to apply:** adding a new surface that shows a tenant style's default icon → call `renderStyleIcon`. In pickers/selects, an FA value won't match a Lucide dropdown option — map FA state to `''` with a sentinel label. FA CSS is loaded globally (main.jsx), so `<i>` works everywhere. button_styles are stored verbatim server-side; no API change needed for new icon values.

---
name: Repeatable availability domain
description: Why whole-container availability differs from the choices available to add another row.
---

Auto-hiding a repeatable element must use Column A's underlying eligible domain after upstream restrictions and earlier-answer exclusions, never the choices remaining after sibling uniqueness.

**Why:** Selecting the last eligible option in an existing row must not hide that row. Conversely, an eligible option excluded by the primary selection is not a usable alternative. A selectable Not Listed fallback keeps the container usable.

**How to apply:** Keep availability resolution active independently of visible rows. Require confirmed successful, complete option results; loading, missing prerequisites, truncation and failures cannot establish emptiness. Preserve raw answers for restoration and server condition evaluation, but exclude authoritatively hidden answers from mappings and notification side effects.
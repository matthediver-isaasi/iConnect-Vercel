---
name: Slate admin surface for shared components
description: How to make light-themed shared components readable on slate/navy admin pages without changing their look elsewhere.
---

On slate/navy admin pages (e.g. Admin Settings), wrap a shared light component's Card in
`dark admin-dark-surface bg-slate-800/50 border-slate-700 text-slate-200` (or pass a tone prop that does so).
`.dark.admin-dark-surface` in index.css remaps the CSS variables (background, muted-foreground, border, input,
primary) to slate values and sets `color-scheme: dark`, so outline buttons, native selects and muted text
become readable without per-element overrides.

**Why:** Admin Settings mixed default white cards and dark-on-navy text; many nested components
(renewal exceptions, outline buttons) rely on theme variables, so explicit per-element classes missed some.

**How to apply:** Use the scope only where the component sits on a slate page; leave the default look for
light pages (Preferences Outlook card, Platform cookie consent). Hard-coded colours like `text-red-600`
or `bg-amber-50` are not remapped and need explicit dark alternatives.

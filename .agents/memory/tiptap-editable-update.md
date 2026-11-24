---
name: TipTap editable-state updates
description: Busy-state toggles can masquerade as author edits and destroy retry evidence.
---

Suppress TipTap's update emission when toggling editability for a pending save.
Treat editing permission/busy state separately from document changes.

**Why:** TipTap emits an update by default when editability changes. In a composer
whose document-change handler clears errors and resets submission identity, this
silently removes recoverable errors and makes a retry look like a new submission.

**How to apply:** Use the non-emitting editability transition for UI state changes.
Test a failed POST followed by retry through the real editor and assert that the
same request identity is retained, not merely that the text stays visible.

## Keyboard event ordering

Picker Enter/arrow handling must precede ProseMirror's default keymaps. Avoid
repeating built-in formatting shortcuts in a bubbling React handler.

**Why:** A bubbling Enter handler runs after ProseMirror has already split the
paragraph and changed selection, which can close a mention picker before it
selects anything. Repeating a formatting command can toggle it twice.

**How to apply:** Exercise real typing, not only synthetic field replacement.
When editor menus live inside a dialog, test that Escape closes only the menu:
the dialog may process native capture events before React can prevent dismissal.

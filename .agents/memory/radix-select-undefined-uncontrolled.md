---
name: Radix Select undefined value goes uncontrolled
description: Clearing a controlled shadcn/Radix Select by setting value to undefined leaves the old selection displayed.
---
Rule: a controlled Radix/shadcn `<Select value={x || undefined}>` becomes *uncontrolled* when the value flips to `undefined`, so it keeps rendering the previously selected item even though app state is cleared.

**Why:** hit on the group-role badge picker — removing a linked badge left the dropdown showing the badge, so it looked still applied.

**How to apply:** when a clear/remove action can set the value to empty, add a remount key tied to the value (e.g. `key={value || 'none'}`) or otherwise never pass `undefined` to a controlled Select.

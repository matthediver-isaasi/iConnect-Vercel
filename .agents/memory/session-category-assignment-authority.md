---
name: Session category assignment authority
description: Hidden category assignments must survive limited editors' replacement payloads.
---

Non-privileged session editors may replace or clear only the category assignments
they are allowed to see. Preserve server-withheld assignments, including unavailable
ones, even when the submitted visible selection is empty. Privileged editors may
explicitly remove them.

**Why:** The active event editor sends category selections on every save. A
visibility-filtered read is not a complete assignment snapshot, so treating its
round-trip payload as full replacement would silently delete another editor's
restricted classifications during unrelated edits.

**How to apply:** Reconcile against authoritative existing assignments on every
write path, without returning hidden IDs or names to the limited editor. Never
solve this by exposing the withheld assignments or trusting a browser flag.

Sessions classify by subcategories, not their parent category headings. Retain
old parent-only selections as historical evidence, without guessing child
assignments or displaying parents as current subcategory badges.

**Why:** The owner corrected the original parent-category implementation; a
parent selection does not establish which children were intended.

**How to apply:** Show parent headings with selectable children, enforce both
parent and child visibility, and require explicit child selections rather than
automatically assigning every child of an old parent selection.

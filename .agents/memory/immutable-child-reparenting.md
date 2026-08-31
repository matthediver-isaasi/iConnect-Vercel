---
name: Immutable child re-parenting
description: Integrity rule for child rows attached to immutable or finalized parent snapshots.
---

An UPDATE trigger protecting child rows of immutable parents must validate both the source parent from `OLD` and the destination parent from `NEW`.

**Why:** Checking only the destination lets a privileged update move a child out of an immutable issued snapshot into an editable draft, changing the historical snapshot without modifying the parent itself.

**How to apply:** For INSERT validate the new parent, for DELETE validate the old parent, and for UPDATE validate both. Apply the same rule recursively to grandchildren such as bundle components.
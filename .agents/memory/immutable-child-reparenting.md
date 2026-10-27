---
name: Immutable child re-parenting
description: Integrity rule for child rows attached to immutable or finalized parent snapshots.
---

An UPDATE trigger protecting child rows of immutable parents must validate both the source parent from `OLD` and the destination parent from `NEW`.

**Why:** Checking only the destination lets a privileged update move a child out of an immutable issued snapshot into an editable draft, changing the historical snapshot without modifying the parent itself.

**How to apply:** For INSERT validate the new parent, for DELETE validate the old parent, and for UPDATE validate both. Apply the same rule recursively to grandchildren such as bundle components.

Draft replacement must explicitly delete grandchildren before deleting parents
when their guards reject missing parents.

**Why:** PostgreSQL cascades can run a child's delete guard after the parent row
has disappeared. A correct fail-closed guard then rejects even a legitimate
draft replacement.

**How to apply:** Fix deletion ordering inside the authorized, locked transaction;
never allow missing parents or disable triggers to make draft saves work. Test
with real foreign keys and the latest wrapper, not a mocked save function.
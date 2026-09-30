---
name: Department relationship replacement
description: Safe replacement and rollback behavior for member-to-Department custom-object relationships.
---

Changing a member's Organisation can automatically archive an active Department relationship before the caller reaches its explicit relationship update. Journal restoration of every initially active edge before changing the Organisation, then re-read active conflicts and archive only those still active. Custom-object relationship rows must be archived rather than hard-deleted, including compensation for newly inserted edges.

**Why:** The live database rejects relationship deletes, and an Organisation-change trigger can make a previously planned active edge inactive during the same operation.

**How to apply:** Any importer or admin flow that changes both `member.organization_id` and Department membership must pre-journal the old active edges, treat the Organisation update as capable of changing edge state, use active-state predicates, and restore the Member before restoring old edges during rollback.
---
name: Category deletion consent boundary
description: Why category deletion requires atomic consent cleanup and explicit campaign reconfiguration.
---

Deleting a communication category is not equivalent to setting all references to NULL. Remove category-owned operational consent rows, preserve global consent and historical delivery evidence, and require deliberate valid reconfiguration before affected campaigns can send again.

**Why:** NULL category references can mean global opt-outs, while removing a campaign's suppression category can broaden delivery. Historical campaigns can also be resumed, so a terminal-looking status alone is not proof that recipient delivery is finished.

**How to apply:** Keep deletion and send claims serialized at the database boundary, account for indirect audience-list and form dependencies, and validate both lock orderings with real concurrent database sessions. Do not reconstruct previously lost preferences without reliable evidence.

Campaign target ID array types differ between the canonical migration chain (`text[]`) and the destination schema inspected in September 2026 (`uuid[]`).

**Why:** A fixture copied from the destination alone passed while deletion failed on a database built from canonical migrations.

**How to apply:** Normalize array comparisons to text and exercise both schema types when changing category targeting SQL.
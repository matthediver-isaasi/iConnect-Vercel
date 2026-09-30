---
name: Legacy transition-row types
description: PostgreSQL transition-table code must tolerate tables with dropped-column history.
---

Do not materialize whole transition-table rows as composite values on long-lived
tables. Compare the named OLD/NEW columns directly.

**Why:** PostgreSQL retains dropped attributes in a table's composite row type.
Whole-row composites can pass on a clean test schema but fail on the real schema
with an `attribute ... has been dropped` compatibility error.

**How to apply:** In statement-level trigger functions, select explicit columns
from transition tables and include a rollback-only smoke test against the actual
schema when the migration enumerates legacy table columns.
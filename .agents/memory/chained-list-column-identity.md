---
name: Chained list column identity
description: Why saved chained columns pin endpoint and display-field identities, and why discovery failure is not an empty schema.
---

Treat a saved chained record-label column as bound to the selected display field, not as an instruction to follow whichever primary field the object uses later.

**Why:** Changing an endpoint or primary display field can change the meaning of a saved list without changing its visible heading. Label renames should preserve selections; semantic retargeting must make them unavailable rather than silently substitute another field.

**How to apply:** Keep relationship definition, traversal side, endpoint, and terminal field identities in the versioned contract. Preserve path occurrences from the listed row, rather than restarting traversal from a shared parent.

Distinguish incomplete discovery from confirmed removal when reconciling saved columns.

**Why:** A bounded graph-discovery failure must not erase personal preferences or break existing scalar/direct lists. Requested unavailable projections should fail explicitly, leaving Columns accessible so the user can remove them.

**How to apply:** Keep saved chained choices when discovery reports a limit/error; only remove stale identities after successful authoritative discovery.
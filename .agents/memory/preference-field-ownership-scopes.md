---
name: Preference-field ownership scopes
description: Isolation rule when preference_field gains a new owning domain beyond existing core entities.
---

When `preference_field` gains a new ownership scope whose values live somewhere other than the existing core preference-value tables, protect the boundary in both directions: hide those definitions and values from legacy reads, and reject their field IDs on legacy writes at both the API and database layers.

**Why:** Filtering the new field definitions alone is insufficient. A caller that knows a field ID can still insert it into a generic core value row, bypass the new domain's validation and permissions, and later disclose it through an old value endpoint.

**How to apply:** For any future ownership scope, inventory every Member, Organisation, and Organisation Group value read/write path. Add explicit server filters plus database triggers or constraints so the old tables accept only their intended field domains.
---
name: Relationship preview config aliases
description: Compatibility rule for relationship-card compact preview metadata stored in old and current configuration keys.
---

Treat `compact_preview` and legacy `compact_preview_fields` as coexisting configuration sources: merge and deduplicate scalar field IDs across both, while direct relationship columns use the current column format.

**Why:** Opening and resaving an older definition can leave legacy IDs in place while adding current metadata. Nullish-precedence selects only one object and silently drops configured card fields; naive concatenation renders duplicates.

**How to apply:** Any validator, projector, editor, or renderer that reads relationship-card preview configuration must process both aliases consistently and deduplicate stable field IDs.
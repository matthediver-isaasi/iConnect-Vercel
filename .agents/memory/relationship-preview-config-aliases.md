---
name: Relationship preview config aliases
description: Compatibility rule for relationship-card compact preview metadata stored in old and current configuration keys.
---

Treat `compact_preview` and legacy `compact_preview_fields` as coexisting configuration sources: merge and deduplicate scalar field IDs across both, while direct relationship columns use the current column format.

**Why:** Opening and resaving an older definition can leave legacy IDs in place while adding current metadata. Nullish-precedence selects only one object and silently drops configured card fields; naive concatenation renders duplicates.

**How to apply:** Any validator, projector, editor, or renderer that reads relationship-card preview configuration must process both aliases consistently and deduplicate stable field IDs.

When no preview is explicitly configured for the linked endpoint, related-record lists inherit that object's selected list fields. Explicit relationship choices—including an empty selection—override the object default.

**Why:** Users expect an object's list presentation to carry through to related-record lists without configuring the same fields twice, while deliberately customized relationship views must remain unchanged.

**How to apply:** Resolve defaults and field permissions server-side, independently of whether the list has rows. Preserve authored override order and labels, and use the same effective columns for projection, sorting, and saved table preferences.
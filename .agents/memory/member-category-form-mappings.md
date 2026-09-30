---
name: Member category form mappings
description: Safety and compatibility rules for prefilling and persisting member resource-category answers from forms.
---

Treat member resource categories as association data, not core or custom member fields. Form mappings must name an explicit member resource-category destination, and submitted values must match that destination's active definition in the authoritative tenant.

**Why:** Subcategory labels can be shared across categories and tenants. Inferring a destination from a label can write the wrong association, while replacing all member category rows can erase unrelated selections.

**How to apply:** Validate source-field compatibility plus destination category ownership and allowed subcategories at write time. Diff only rows for each explicitly mapped destination. Keep legacy category fields readable/prefillable, and let optional category-read failures degrade to empty category defaults without suppressing other member prefill data.
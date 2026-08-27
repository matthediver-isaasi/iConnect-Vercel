---
name: Organisation preference tenant scope
description: How to tenant-scope organisation custom-value writes against the live destination schema.
---

The destination `organization_preference_value` relation does not carry a direct tenant identifier. Importers must not assume one exists.

**Why:** A checked destination write failed because an older/newer schema convention was assumed. Tenant safety still needs to be explicit even without a tenant column.

**How to apply:** Resolve both organisation IDs and preference-field IDs through tenant-filtered reads first, then constrain custom-value updates by the custom-value ID plus those resolved parent and field IDs. Check every response.
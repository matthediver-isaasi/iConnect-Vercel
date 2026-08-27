---
name: Cross-tenant member cleanup references
description: Safety boundary for deleting one tenant's members when globally keyed legacy references can exist in another tenant's rows.
---

A tenant-scoped member cleanup must inventory every live and soft member reference and abort if a row owned by another tenant points at a deletion candidate. Do not assume a member UUID is referenced only inside its owning tenant.

**Why:** Legacy data can contain cross-tenant references, including operational records that remain valid. Allowing FK behavior or generic detach logic to process those references would silently mutate another tenant's history.

**How to apply:** Resolve candidates by the member's owning tenant, compare every referencing row's tenant before mutation, and treat any mismatch as a separate business-policy decision. Never bypass the guard or broadly null the foreign tenant's reference inside the original cleanup.
---
name: Cross-tenant member cleanup references
description: Safety boundary for deleting one tenant's members when globally keyed legacy references can exist in another tenant's rows.
---

A tenant-scoped member cleanup must inventory every live and soft member reference and abort if a row owned by another tenant points at a deletion candidate. Do not assume a member UUID is referenced only inside its owning tenant.

**Why:** Legacy data can contain cross-tenant references, including operational records that remain valid. Allowing FK behavior or generic detach logic to process those references would silently mutate another tenant's history.

**How to apply:** Resolve candidates by the member's owning tenant, compare every referencing row's tenant before mutation, and treat any mismatch as a separate business-policy decision. Never bypass the guard or broadly null the foreign tenant's reference inside the original cleanup.

A nullable `tenant_id` on a dependent row is not automatically cross-tenant. Some legacy tables added tenant ownership after the fact and could not backfill rows for unassigned Members.

**Why:** Treating NULL as foreign can block a correct cleanup, but treating every NULL as local can delete globally owned data.

**How to apply:** Allow a NULL-tenant dependency only for a table whose ownership is proven by its Member reference, and pin the exact expected row count/signature. Continue to fail closed for every other unscoped dependency.
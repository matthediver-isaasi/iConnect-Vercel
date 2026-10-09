---
name: Sales collaborator scope
description: Collaborators belong to the tenant's own organisation, not its customers.
---
Sales opportunity collaborators should be members attached to the tenant's own primary organisation. Customer-organisation members belong in Contacts, not the collaborator picker.

**Why:** The user explicitly corrected the proposed tenant-wide collaborator selection and requested this scope.

**How to apply:** Keep discovery and new collaborator writes scoped to the primary organisation. Do not substitute an arbitrary organisation if primary configuration is absent, or silently remove historical assignments.

---
name: Sales collaborator scope
description: Collaborators belong to the tenant's own organisation, not its customers.
---
Sales opportunity collaborators should be members attached to the tenant's own primary organisation. Customer-organisation members belong in Contacts, not the collaborator picker.

**Why:** The user explicitly corrected the proposed tenant-wide collaborator selection and requested this scope.

**How to apply:** Keep discovery and new collaborator writes scoped to the primary organisation. Do not substitute an arbitrary organisation if primary configuration is absent, or silently remove historical assignments.

Quote salesperson eligibility uses this same primary-organisation team boundary.

**Why:** There is no separate salesperson eligibility model; using the existing Sales team rule avoids treating customer contacts or every tenant member as staff. Existing quote snapshots remain historical evidence, not new eligibility grants.

**How to apply:** Reuse the team eligibility rule for new selections, while retaining unchanged server-loaded salesperson snapshots when colleagues leave or become ineligible.

Proposal sender selection should offer the opportunity's collaborators and default to the authenticated user.

**Why:** The user requested selectable collaborator senders rather than a fixed tenant sender identity.

**How to apply:** Treat this as a requested behavior, not an existing access guarantee. Clarify owner/admin eligibility and visible From versus Reply-To before implementation; do not assume Sales permission alone proves collaborator membership.

---
name: Organization directory filters vs admin surfaces
description: Directory exclusion/status filters apply to ALL non-tenant-admin Organization list calls unless the skip flag is passed and authorised.
---

The Organization list endpoint applies the public-directory filters (excluded orgs + allowed application statuses) to every non-tenant-admin session by default. Portal users with CRM access must explicitly request the unfiltered list; the server only honours the skip flag when the role has cross-org access, so admin surfaces can pass it unconditionally.

**Why:** directory hiding is front-of-house only; without the skip, excluded orgs silently vanish from admin pickers (member-create dropdowns, on-behalf selectors) for portal-based admins.

**How to apply:** any admin/CRM or permission-gated cross-org surface listing organisations must use the shared admin org-list helpers rather than the plain entity list (search for adminOrgList). Public/member-facing directory lists must stay on the plain list so filtering remains intact. Note the legacy string-sort call form cannot carry extra query params.

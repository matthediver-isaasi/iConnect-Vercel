---
name: Member security and lifecycle topics
description: Tenant-scoped member cleanup, admin authorization, access revocation, and member-only context.
---

Use the focused topic that matches the change:

- [Cross-tenant member cleanup references](cross-tenant-member-cleanup-references.md) — fail closed when another tenant references candidate UUIDs during tenant-scoped deletion.
- [Bulk Member deletion FK indexes](bulk-member-delete-fk-indexes.md) — missing child FK indexes cause full-table scans during bulk deletion.
- [Tenant-scoped admin password resets](tenant-admin-password-reset-scope.md) — reset the request tenant, not the admin default; never trust Origin for reset links.
- [Organisation access revocation](organisation-access-revocation.md) — restoration must not revive old sessions; fence concurrent creation without revoking unrelated organisations.
- [Member-only tenant context](member-only-tenant-context.md) — ordinary members lack admin-selected tenant state; test member-only authentication.
---
name: Directory-owned member scope
description: Security boundary for opening organisation contacts from standard, dynamic, or embedded organisation directories.
---

An organisation directory's member/contact view must be owned by that source directory, with access, tenant, organisation eligibility, and configured contact roles all resolved server-side. Never use URL markers or client-supplied role IDs to turn the standalone Member Directory into an alternate role-scoped view.

**Why:** A role can legitimately access an organisation directory while being denied the general Member Directory. Reusing the general directory with query parameters creates an authorization bypass and can expose other organisations or roles.

**How to apply:** Give each organisation directory a nested member route and scoped endpoint. Compose source-directory access with tenant, eligible organisation, contact-role, opt-out, disabled-account, and deleted-member rules. Keep the standalone Member Directory's authorization and filters independent.
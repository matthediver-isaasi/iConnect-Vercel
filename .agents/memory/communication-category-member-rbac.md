---
name: Communication category member RBAC
description: Security rule for communication-category visibility and member subscription writes.
---

Communication-category applicable roles govern every member-facing read and every member opt-in, including public signup, preference links, signed-in preferences, form-driven subscriptions, and admin member cards. A public category remains open to genuine external subscribers, but the public flag never bypasses member role eligibility. Categories with no role assignments are available to all members.

**Why:** Member identity can be discovered after a nominally public or anonymous flow begins. Checking only the public flag or filtering only in the UI lets known-member emails opt into categories their role should not access.

**How to apply:** Resolve the member first, then use the shared eligibility rule before exposing categories or writing `is_subscribed=true`. Admin cards must consume a tenant-scoped server response rather than rebuilding eligibility from client entity queries. Keep server-side write checks even when the UI is filtered. Permit `is_subscribed=false` for a previously stored category after role access is removed.
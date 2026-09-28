---
name: Member-only tenant context
description: Admin tenant state is not guaranteed for authenticated member sessions.
---

Do not require the admin-selected global tenant ID to enable a member-only feature. Resolve the member tenant from the validated authenticated session, and reject conflicting contexts rather than guessing.

**Why:** Member-only sessions deliberately do not bootstrap the admin tenant selector. A browser fixture authenticated as both admin and member hid a missing assistant launcher for ordinary members.

**How to apply:** Test member portal features with the tenant-admin auth endpoint returning unauthenticated. Pin requests and caches to validated member identity and tenant; separately test admin preview and tenant switching.
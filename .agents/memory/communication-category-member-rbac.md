---
name: Communication category member RBAC
description: Security rule for communication-category visibility and member subscription writes.
---

Communication-category member access is governed first by the audience mode, then by applicable roles. Public-only categories are excluded from every member-facing read and member opt-in, including public signup with a known-member email, preference links, signed-in preferences, forms, imports, and admin member cards. Public access remains available to genuine external subscribers. Categories with no role assignments are available to all members only when the member audience is enabled.

**Why:** Member identity can be discovered after a nominally public or anonymous flow begins. Checking only the public flag or filtering only in the UI lets known-member emails opt into categories their role should not access.

**How to apply:** Resolve the member first, then use the shared eligibility rule before exposing categories or writing `is_subscribed=true`. Do not allow generic entity writes to bypass guarded preference APIs. Keep server-side checks even when the UI is filtered, and permit `is_subscribed=false` after audience or role access is removed.
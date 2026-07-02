---
name: Private subsets within a tenant-scoped entity
description: Why client-side filtering of a tenant-wide entity list is not access control, and where to add the server-side guard.
---

# Private subsets within a tenant-scoped entity

When a single tenant-scoped entity contains rows that should be private to a
*subset* of the tenant's members (e.g. forum_category rows with a non-null
group_id that belong only to that member group), **client-side filtering is not
access control**. The generic entity API (`api/entities/[entity]/index.js` GET
list and `api/entities/[entity]/[id].js` GET by-id) only applies tenant isolation
— it returns every tenant row. A member can read the private rows directly via
`/api/entities/<Entity>` or `?categoryId=`/by-id URLs even if the UI hides them.

**Why:** the per-group forum work shipped UI-only filtering first; code review
flagged that any forum-enabled member could read another group's
categories/threads/posts by hitting the API or setting the URL param manually.

**How to apply:**
- Add a server-side filter on BOTH the list and by-id read paths, right before
  `res.json(...)`. Filter the already-fetched rows by the caller's membership.
- Exempt privileged callers so admin/management surfaces still see everything:
  `tenantCtx.tenantUserId` (tenant admin) OR
  `hasFeatureAccess(tenantCtx.roleId, '<feature>')` (e.g. `forum.management`).
- For child entities, resolve up the chain (post -> thread -> category) to find
  the owning private row's group_id, and respect the parent's is_active so a
  disabled/deactivated private board denies access too.
- Fail closed on errors for the privacy-bearing entity (drop unverifiable
  group-linked rows) rather than leaking.
- Identity comes from `getTenantContext(req)` (`memberId`, `roleId`,
  `tenantUserId`); group membership is in `member_group_assignment`.

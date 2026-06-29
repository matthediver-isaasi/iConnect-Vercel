---
name: getTenantIdFromSession only checks membership
description: Why admin-only API endpoints must use hasAdminAccess, not just getTenantIdFromSession
---

`getTenantIdFromSession(req)` (defined in `api/_lib/zoomClient.js` /
`api/_lib/zohoCampaignsClient.js`) returns a tenant id for ANY authenticated
session that belongs to a tenant. It verifies tenant *membership* only — it does
NOT check whether the caller is an admin.

**Rule:** any `/api` endpoint that returns admin-scoped data (e.g. enumerating
other entities' titles/times, including group-private rows) must gate with
`getTenantContext(req)` + `hasAdminAccess(context)` and return 403 for
non-admins. Use `getTenantIdFromSession` only when the endpoint's data is safe
for any tenant member.

**Why:** a clash-detection endpoint was first gated with `getTenantIdFromSession`
only. Code review flagged that any authenticated tenant member could call it
directly and enumerate event/session titles and times (incl. group-private
events) — sensitive scheduling metadata. Switching to `hasAdminAccess` closed
the leak.

**How to apply:** `hasAdminAccess(context)` is true for tenant-dashboard users
(`context.tenantUserId`) and for members whose role passes
`checkCrossOrgPermissions(roleId).isAdmin`. Group admins (the `n` flag) are NOT
admins, so they get 403 — design advisory features to degrade gracefully on 403
(treat as "no result") rather than block.

---
name: Canvas preview authorization
description: Public preview flags must not authorize cached authoring content.
---
Canvas preview intent is not editor authorization; absence of a member session does not prove a tenant-admin session.

**Why:** The two login systems made an anonymous preview look like an admin preview. Even when fresh server requests were denied, a stable editor query key could retain protected content through session expiry.

**How to apply:** Require positively resolved member capability or a validated tenant-user session before selecting authoring data, scope query audiences to that validation, and test expiry after priming an editor response.
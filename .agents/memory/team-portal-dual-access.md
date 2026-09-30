---
name: Team and portal dual access
description: Lifecycle tradeoff when team access shares a portal membership.
---

Revoking team access on a linked portal membership should remove team privileges, not disable or delete the shared membership. Re-inviting grants team access again; inactivation is not a separate suspended-team state for these rows.

**Why:** The identity/tenant uniqueness contract allows only one membership, and the team status field cannot independently represent portal and team suspension. Team administration must not revoke a person's unrelated member access.

**How to apply:** Keep team lifecycle actions distinct from explicit member-login controls. If independently resumable team suspension becomes a requirement, design a separate access-state representation rather than overloading the shared status.
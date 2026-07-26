---
name: GoCardless arrears & DD console
description: Durable invariants for DD arrears handling and admin-console authz that future changes must preserve.
---

- **Grace days are a SNAPSHOT, and the grace window is non-rolling.** Grace comes from the agreement's stored metadata at consent, never live tier config; repeat failures inside grace keep the original expiry, only post-expiry failures escalate to overdue.
  **Why:** changing tenant config must never retroactively shorten/extend a member's already-running grace period, and re-failed retries must not push the deadline out forever.
  **How to apply:** any new failure path must reuse the existing failure handler, not recompute grace from config.
- **The never-double-charge guard must THROW (fail-closed).** It once returned `{ok,reason}` while every call site wrapped it in try/catch — a silent pass-through that would have allowed retrying an in-flight payment. A retry may only proceed when the LIVE GoCardless payment status is exactly `failed`.
  **How to apply:** new retry surfaces call the shared assert and surface the throw as a 409; never re-implement the check inline.
- **Arrears policy applies exactly once** via a `... IS NULL` guard on the applied-policy column, so cron sweep and webhook path can race safely; `keep_active` records but never flags the agreement. Restrict/suspend enforcement downstream is intentionally not wired yet (bookkeeping only).
- **Admin money-moving actions need server-side feature RBAC, not just `hasAdminAccess` + client gating.** Pattern: tenant-user dashboard sessions (no roleId) pass; member-role admins need the console feature key, and refunds additionally need the finance feature key.

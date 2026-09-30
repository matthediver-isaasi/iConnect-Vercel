---
name: Platform-managed tenant integrations
description: How a shared server credential combines with per-tenant enablement without exposing or duplicating the secret.
---

A platform-managed integration stores only the tenant enable/disable row. Its credential remains exclusively in the server environment, and admin status exposes only a boolean configuration state.

**Why:** Treating a shared provider like tenant-owned OAuth/API credentials risks returning a masked derivative, accepting forged per-tenant credentials, or making an unsaved integration impossible to display.

**How to apply:** Return a synthetic disabled status when no tenant row exists, reject credential payloads, reject enablement when the platform secret is absent, and re-check both platform configuration and the tenant toggle on every provider request.
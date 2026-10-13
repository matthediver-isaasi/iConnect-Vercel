---
name: Public branding freshness
description: Public branding must not depend on cross-instance local cache invalidation.
---

Treat cached tenant rows as host-resolution hints, not current branding authority. Public branding and server-injected chrome must read current persisted settings on each new request.

**Why:** An admin save clears only its own serverless instance's Map; another instance can keep returning an older header configuration even though explicit tenant lookup shows the saved value. A matching pair of live reads after cache expiry does not prove this race is fixed.

**How to apply:** Preserve host authorization and active-tenant checks, use one authoritative row per render, retain legacy-column fallback, and fail explicitly rather than serving stale branding when that read fails. Test with independently warmed reader/writer caches.

See [Tenant favicon delivery boundaries](tenant-favicon-boundary.md) for normalization without asset mutation and separate public-rollout evidence.

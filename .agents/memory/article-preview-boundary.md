---
name: Shared article preview boundary
description: Password previews must not participate in authenticated entity fetching or shared data caches.
---

Shared draft access is a separate, server-verified capability, even for signed-in viewers. Keep passwords and draft responses out of React Query and persistent browser storage.

**Why:** Guest entity reads returned session-invalid responses and repeatedly cleared the shared query cache. Client-side password comparison also disclosed the protected draft and its password before verification.

**How to apply:** Use the tenant-resolved public password endpoint, minimal display-author projections, and fresh verification on navigation. Preserve generic entity authorization and tenant page-visibility overrides.

The existing service-only quote rate-counter RPC is intentionally reused with a separate article-preview digest namespace and fail-closed behavior.

**Why:** Its atomic database counters already work across serverless instances; a process-local counter cannot protect short share passwords. No quote token or quote authorization is reused.

**How to apply:** Preserve namespace separation if extracting a generic limiter. Do not replace the shared counter with an in-memory fallback when the database is unavailable.

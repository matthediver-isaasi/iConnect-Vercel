---
name: External services and environment
description: Durable provider, deployment and workspace operational constraints.
---
- [Better Stack subhourly timezone](better-stack-subhourly-timezone.md) — clear server timezone adjustment with approval before subhourly intervals.
- [Workspace DB targets](workspace-db-targets.md) — SOURCE is stale; destination-only migration and verification safeguards.
- [Merge is not public rollout](merge-vs-public-rollout.md) — verify the public bundle rather than assuming merge means release.
- [Custom-domain recovery](custom-domain-recovery.md) — verify hosting and tenant mapping independently.
- [Vercel runtime log access](vercel-runtime-log-access.md) — live streams cannot establish earlier failures.
- [Git authentication authority](git-authentication-authority.md) — read/connection health does not establish push authority.
- [Portable npm downloads](portable-npm-downloads.md) — avoid workspace-only registry URLs in lockfiles.
- [CookieYes isolation limitations](cookieyes-sdk-isolation.md) — shared-origin SDK isolation requires explicit policy.
- [Outlook busy-time handling](outlook-busy-times.md) — timezone parsing, pagination and failure handling.
- [WordPress option leases](wordpress-option-leases.md) — compare-and-swap takeover and compare-and-delete release.

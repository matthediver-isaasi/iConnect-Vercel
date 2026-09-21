---
name: Session role readiness
description: Safe reuse of verified role data, terminal failures, and observer-driven loading loops.
---

A session-supplied role can eliminate a second permissions request, but must remain tied to the verified member, tenant, role and session. It must still participate in explicit role-query invalidation.

**Why:** Permanently preferring an authentication snapshot would leave navigation using old permissions after role changes. Missing role data is especially dangerous in an exclusion-based policy: an empty exclusion list means unrestricted access, not a failed lookup.

**How to apply:** Keep trusted snapshots out of persisted member data, clear them on identity/auth changes, distinguish unavailable roles from valid unrestricted roles, and make failures terminal with a retry action. Preserve role invalidation when optimizing the first read.

Keep a successfully loaded role fresh within its validated session rather than automatically refetching whenever another access-hook consumer mounts.

**Why:** If a refetch closes access readiness, it unmounts protected children. A child that refetches stale role data on every mount can then repeatedly close readiness and unmount itself.

**How to apply:** Test a late second observer and explicit invalidation separately. New session generations and deliberate invalidations must still refresh permissions; mounting another consumer must not create a request loop.

Protected route guards must derive readiness and permissions from the same session-role observer, not an effect-published Layout permission callback.

**Why:** Hidden portal children still run redirects. A stale deny callback can redirect an authorized member during loading; a stale allow callback can mount protected workspaces before refreshed permissions resolve.

**How to apply:** Gate workspace mounting and redirects on a ready, identity-matched role. Keep missing/error states recoverable and distinguish them from confirmed exclusion.
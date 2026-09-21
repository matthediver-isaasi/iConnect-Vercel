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

Browser fixtures that authenticate a member must also supply a valid tenant-matched role lookup, even when testing public Canvas previews.

**Why:** Older member-only fixtures returned generic empty metadata for role-by-id reads. After role readiness became fail-closed, this caused editor and draft-preview failures unrelated to the feature under test.

**How to apply:** Model the intended member capability explicitly in fixture role responses; do not bypass guards or promote the fixture to an administrator merely to recover an older test.

Route readiness and session lifetime are separate boundaries. A pathname change must not invalidate a trusted session; keeping it across navigation requires bounded revalidation and explicit identity/auth invalidation.

**Why:** Route-scoped authentication cleared trusted roles on every navigation and repeatedly replaced the entire portal with its loading state. Reusing permissions indefinitely would fix the visual symptom by weakening revocation handling.

**How to apply:** Scope session discovery to the tenant and authentication generation, fence old responses, and test ordinary navigation separately from expiry, explicit invalidation, and account changes. Route decision leases still expire on navigation and must never carry public/blank/microsite chrome into another destination.
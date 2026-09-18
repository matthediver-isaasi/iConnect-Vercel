---
name: Route-owned chrome decisions
description: Why Canvas chrome must be authorized synchronously at the shared route boundary.
---

Treat header/footer visibility as a lease for a particular route, tenant, microsite, and audience. An unresolved lease allows neither component to mount. Resetting readiness in a child layout effect is too late: excluded components have already committed, even if the browser has not painted.

**Why:** Cold loads began with full chrome, and disabled dependent queries looked “not loading.” Cleanup resets also reopened the previous page's full chrome during navigation. Hiding the shell with CSS did not prevent DOM insertion or component effects.

**How to apply:** Invalidate the lease during boundary rendering, including when prerequisite readiness changes. Resolve all page/layout flags atomically, never reset them to full chrome in cleanup, and keep the public content parent stable. During same-route refetches, retain the resolved shell kind even while chrome readiness closes; otherwise switching public/portal parents remounts the page and starts another refetch indefinitely. Use actual route matching rather than the final URL segment; a microsite slug can collide with a built-in route. Tests must record insertion/mount history from startup, not just the final screen.
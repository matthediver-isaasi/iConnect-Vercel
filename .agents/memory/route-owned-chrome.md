---
name: Route-owned chrome decisions
description: Why Canvas chrome must be authorized synchronously at the shared route boundary.
---

Treat destination public header/footer visibility as a lease for a particular route, tenant, microsite, and audience. An unresolved lease allows neither public component to mount. Resetting readiness in a child layout effect is too late: excluded components have already committed, even if the browser has not painted.

**Why:** Cold loads began with full chrome, and disabled dependent queries looked “not loading.” Cleanup resets also reopened the previous page's full chrome during navigation. Hiding the shell with CSS did not prevent DOM insertion or component effects.

**How to apply:** Invalidate the lease during boundary rendering, including when prerequisite readiness changes. Resolve all page/layout flags atomically, never reset them to full chrome in cleanup, and keep the public content parent stable. During same-route refetches, retain the resolved shell kind even while chrome readiness closes; otherwise switching public/portal parents remounts the page and starts another refetch indefinitely. Use actual route matching rather than the final URL segment; a microsite slug can collide with a built-in route. Tests must record insertion/mount history from startup, not just the final screen.

An optional custom login page's confirmed absence is a resolved built-in page, not a failed Canvas layout lookup. Keep this exception local to login, and distinguish absence from tenant, transport, and database errors.

**Why:** Applying the shared fail-closed error layout to an ordinary missing custom login page removed the tenant header/footer from the otherwise usable default login. Conversely, treating every 404 as absence would grant chrome on tenant-resolution failures.

**How to apply:** Resolve the explicit missing/unpublished page response to the default login layout. Preserve genuine lookup failures as errors end-to-end, including at the API, rather than disguising them as missing content. Do not relax general missing-page or pending-route protections.

Keep chrome authorization separate from starting network reads. Session and published-page requests can run alongside layout settings, but consuming page content still requires the resolved route and viewer.

**Why:** Extending anti-flash readiness to the requests themselves serialized page loading behind settings and session validation, leaving a visually blank page. A prefetched cookie-backed response also cannot safely survive an account switch merely because the eventual viewer is authenticated.

**How to apply:** Show neutral visible loading feedback; fence buffered responses across route, tenant, mount and account changes, including switches before the first auth result. Test request ordering with deliberately blocked settings/auth, as well as protected-content absence and header/footer insertion history.

An already validated portal shell may persist across compatible navigation, but its presentation continuity must never serve as destination authorization.

**Why:** Expiring route decisions is necessary, yet defaulting every unresolved dynamic destination to a public parent destroys sidebar DOM and local state even when the session remains valid. Session-request reuse alone cannot fix that transition.

**How to apply:** Keep shell compatibility separate from route leases. Invalidate continuity on session, tenant, account, role, or microsite boundaries, and reconcile explicit public/blank settings when discovered. Keep pending destination content gated and test shell node identity and local state during slow discovery and history navigation, not just request counts.
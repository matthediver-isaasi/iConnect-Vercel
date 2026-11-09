---
name: CookieYes SDK isolation limitations
description: Published SDK storage and retry limitations to resolve before tenant-aware integration.
---

The inspected official packages @cookieyes/react 0.13.3 and @cookieyes/scripts 0.3.0 both depend on @cookieyes/core 0.12.0. That core hardcodes a host-only `cookieyes-consent` cookie and origin-local `cookieyes-consent-records` retry queue. Its public configuration has no storage namespace option; the retry dispatcher installs an online listener and timers without exposing disposal. Its taxonomy hash includes category IDs, required flags and Google signal mappings, not policy wording.

**Why:** Host-only cookies separate domains but not tenants sharing one origin. Reinitializing the UI cannot be assumed to isolate pending records or invalidate consent after a material policy change.

## Form iframe consent ownership

The surrounding page owns the cookie interface for embedded forms; suppression must not be treated as permission to track inside the frame.

**Why:** Starting another consent engine creates duplicate controls and independent analytics sessions. Parent consent is not automatically trusted across frame or tenant boundaries.

**How to apply:** Keep optional tracking denied in form embeds unless a separately reviewed consent-sharing contract is introduced. Standalone form URLs must retain their own consent controls.

**How to apply:** Recheck the installed version's contract before integration. The owner approved a minimal, version-pinned SDK patch for tenant isolation, policy revision and retry cleanup. Do not replace the consent engine or globally intercept browser storage. Preserve the SDK's bounded retry semantics: at most ten records for seven days, not indefinite delivery.

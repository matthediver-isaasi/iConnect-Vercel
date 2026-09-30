---
name: Save-first metadata discovery
description: Avoid invalid-draft deadlocks and stale public tenant hints in authenticated editor discovery.
---

Save-first discovery must not let the editor create a configuration that strict save validation rejects before a saved identity exists.

**Why:** Disabling only the object picker leaves an incomplete source in the form; saving cannot produce the identity needed to complete it.

**How to apply:** Disable identity-dependent source modes before the first save, show guidance before selection, and retain strict saved-source validation.

Authenticated discovery must not inherit a public client's cached tenant query parameter when using an active tenant UUID header.

**Why:** Tenant resolution can process the public query before the header, producing a false tenant mismatch after a switch.

**How to apply:** Use authenticated tenant transport with a verified UUID and scope query keys to form, tenant, and principal.
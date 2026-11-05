---
name: Homepage canonical authority
description: Homepage settings are mutable routing authority, not permanent cached slug aliases.
---
An explicitly cleared modern homepage setting must override the legacy tenant setting. Homepage redirects must be uncacheable even when permanent, and must validate public default-site ownership and route precedence first.

**Why:** Clearing a selection must not resurrect a legacy homepage; changing it must not strand the former slug in browser/CDN redirect caches. A matching slug may instead belong to an active microsite or registered route.

**How to apply:** Keep absence, invalid selection and lookup failure separate. Test selection changes without cache purges. SPA canonicalization must also refresh initial metadata, not just change the address bar.

CMS feature verification must include the canonical homepage destination, not just the authored slug.

**Why:** A slug may redirect to the root homepage, which can use a separate renderer. Correct audience checks and timers cannot help when that renderer never starts the feature.

**How to apply:** Follow the actual redirect and verify feature requests and mounting on the destination; cover homepage and ordinary-page paths without bypassing session or preview gates.

---
name: Homepage canonical authority
description: Homepage settings are mutable routing authority, not permanent cached slug aliases.
---
An explicitly cleared modern homepage setting must override the legacy tenant setting. Homepage redirects must be uncacheable even when permanent, and must validate public default-site ownership and route precedence first.

**Why:** Clearing a selection must not resurrect a legacy homepage; changing it must not strand the former slug in browser/CDN redirect caches. A matching slug may instead belong to an active microsite or registered route.

**How to apply:** Keep absence, invalid selection and lookup failure separate. Test selection changes without cache purges. SPA canonicalization must also refresh initial metadata, not just change the address bar.

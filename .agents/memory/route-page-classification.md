---
name: Route page classification
description: How Layout's currentPageName is derived for parameterised routes, and why some keep the hybrid _DynamicPage marker.
---
Parameterised routes the URL classifier can't name fall back to the matched route component's PAGES name; only DynamicPage routes are always `_DynamicPage`. Static aliases are not reclassified.

**Why:** `_DynamicPage` is treated as hybrid ("handles its own auth"), so protected ID routes (e.g. /FormSubmission/:id) skipped the login redirect and 401'd into a session-rejected cache clear.

**How to apply:** A new guest-readable parameterised route must be added to the hybrid-retain set (or a prefix rule), otherwise it becomes portal-gated by default. Portal pages still mount children hidden behind the readiness gate, so protected pages should gate queries on a validated session.

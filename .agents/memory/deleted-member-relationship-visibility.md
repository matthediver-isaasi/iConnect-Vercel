---
name: Deleted-member relationship visibility
description: Keep deliberate identity suppression distinct from broken endpoints and historical relationship storage.
---

Custom Object presentation must distinguish an intentionally suppressed anonymised member from an unavailable endpoint. Do not treat every unresolved endpoint as deletable display noise.

**Why:** Member deletion preserves both its row and relationship history. Dropping labels after paging produces misleading totals and sparse pages; dropping every missing endpoint hides genuine integrity or tenant-access problems. Login and directory flags are independent controls, not evidence of deletion.

**How to apply:** Apply the deletion-placeholder email eligibility before counts and pagination, retaining explicit exclusion evidence for hydration. Preserve missing-endpoint errors and stored edges. Shared resolver changes need caller-specific checks, especially core-record pickers and historical reports.
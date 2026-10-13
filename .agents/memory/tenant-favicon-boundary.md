---
name: Tenant favicon delivery boundary
description: Approved favicon source and rollout boundaries.
---

Keep favicon delivery separate from saved artwork: proportionally fit public uploaded images instead of mutating tenant assets or settings.

**Why:** The approved work fixes delivery, not artwork; production mutations and rollout require separate approval. Search-engine cache selection cannot be inferred from correctly served HTML.

**How to apply:** Preserve tenant-level ownership on microsites. If expanding accepted image origins beyond public upload storage, retain pinned public DNS, bounded decoding and no recursive icon fetching. Report local proof separately from public rollout and Google's later refresh.

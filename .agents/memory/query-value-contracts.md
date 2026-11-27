---
name: Query value contracts
description: Shared query keys require identical result semantics across editor and member surfaces.
---

Use separate query keys for raw optional editor configuration and effective, default-filled member configuration. Invalidate both when the underlying setting changes.

**Why:** Navigating from settings back to About-me exposed a cache collision: an editor's valid absent-setting result replaced a member view's required array. Full-page reload tests passed because each reload created a fresh cache.

**How to apply:** Verify settings-to-member flows through same-session SPA navigation as well as reload persistence. Compare result semantics, including absent/default/error shapes, before reusing another page's query key.

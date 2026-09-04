---
name: Custom Object cardinality migrations
description: Safely widening a live Custom Object relationship without replacing its definition or edge history.
---

A relationship definition's cardinality is protected as immutable. A tenant-pinned widening migration must first validate the exact object, endpoints, current/target cardinality, configuration, and every active edge invariant. It may then temporarily disable only the definition identity guard, update that same definition row, re-enable the guard, and assert exactly one row changed. Ship the widening as a new forward migration; never edit the dated migration that originally created the definition.

**Why:** Replacing or archiving the definition loses continuity with existing edges and history, while a normal update is rejected by the foundation guard. An edited historical migration will not replay on databases that already recorded it. Globally installed trigger functions can also affect tenants outside the pinned migration, so narrowing their cardinality predicates can silently remove legacy protections.

**How to apply:** Use this only for a narrowly pinned forward migration, keep the operation transactional, preserve the definition ID, leave duplicate-edge protection active, and prove the real old-to-new sequence with replay and retained-edge checks. If global trigger functions are replaced, test an unaffected tenant on the legacy cardinality too.
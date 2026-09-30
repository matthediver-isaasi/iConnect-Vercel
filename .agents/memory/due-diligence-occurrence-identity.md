---
name: Due diligence action occurrence identity
description: Retry identity must distinguish stage entry from worker attempts and unrelated record edits.
---

Use a persisted stage-entry identity for durable mapping events, stable across initialization leases and retries but renewed for a genuine stage transition.

**Why:** Worker lease tokens change during recovery, and updated timestamps change during review/history writes. Either can create duplicate effects. Permanent action IDs have the opposite problem: later stage entries can mutate records while conflicting with old outbox events.

**How to apply:** Preserve the occurrence across retries, protect it from generic entity writes, and check existing event identity and payload before mutating. A later entry must receive a new occurrence through the same compare-and-swap that changes the stage.
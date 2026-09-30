---
name: Due diligence action occurrence identity
description: Retry identity must distinguish stage entry from worker attempts and unrelated record edits.
---

Use a persisted stage-entry identity for durable mapping events, stable across initialization leases and retries but renewed for a genuine stage transition.

**Why:** Worker lease tokens change during recovery, and updated timestamps change during review/history writes. Either can create duplicate effects. Permanent action IDs have the opposite problem: later stage entries can mutate records while conflicting with old outbox events.

**How to apply:** Preserve the occurrence across retries, protect it from generic entity writes, and check existing event identity and payload before mutating. A later entry must receive a new occurrence through the same compare-and-swap that changes the stage.

A saved stage is not proof that its actions completed, and a processing delivery row is not proof that its worker died.

**Why:** Stage writes precede external effects. Older-stage outbox events can block later stages, and another dispatcher can observe an active owner's processing row. Reclassifying that row destroys useful evidence and can race the actual owner.

**How to apply:** Report persisted-stage attention separately from mutation failure. Preserve processing/attention rows and their original errors; never replay a whole stage merely because its fanout has a retryable failure. Whole-stage retries need durable evidence for every earlier effect, including status webhooks.

Treat synchronous field-mapping fanout as part of the stage request's execution budget, not as background work.

**Why:** A gateway timeout can terminate delivery after successful workflow effects but before completion is recorded. Later attention errors identify the blocker, not the original interruption.

**How to apply:** Correlate the original request's status and duration with durable evidence. Reduce repeated condition reads only within an evaluation, invalidate after actions, and retain conservative no-replay behavior even when increasing the endpoint budget.
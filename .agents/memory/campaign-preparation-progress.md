---
name: Campaign preparation forward progress
description: Why durable audience-read replay alone is insufficient for large campaigns.
---

Campaign preparation needs bounded, durable resolver continuations; journaling reads alone is not a sufficient resumability guarantee.

**Why:** Replaying an ever-growing segment history can consume the entire invocation budget before the worker reaches a new read. This remains possible even when individual reads are cached, paginated, and deadline-checked. Audience semantics also include cross-page deduplication and consent, so arbitrary slicing of the legacy resolver changes results.

**How to apply:** Keep source scan cursors, intermediate evidence, reductions, and candidate insertion progress durable. Replay only one bounded transition after a crash. Test forward progress with a large existing checkpoint history, not just successful small retries. Never use the existence of recipient rows as evidence that preparation is complete.

An empty low-numbered journal page does not prove that a transition has no
saved reads: parallel work may persist a higher sequence before a crash.

**Why:** A cache-miss optimisation must not silently reread sources and change
the audience during recovery.

**How to apply:** Establish emptiness across the whole scoped transition with
a bounded query before skipping replay lookups. Retain identity-based replay
for sparse/reordered history and checkpoint each successful new source read.
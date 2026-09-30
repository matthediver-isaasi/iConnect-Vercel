---
name: Composite form mapping components
description: Cross-path invariant for mapping one scalar component from a structured form answer.
---

When a field mapping selects one component of a structured answer, extract that component before transformations, identity resolution, emptiness checks, and target assignment in every mapping path. Ordered fallbacks must choose using the same extracted scalar that will be written.

**Why:** Mapping processors have separate top-level, primary-pipeline, and additional-record paths. Applying component extraction in only some paths can write whole objects, choose the wrong fallback winner, or resolve identity from a different value than the one assigned.

**How to apply:** Reuse one extraction contract across all modern mapping processors, validate component metadata against the persisted source field, and include identity/uniqueness mappings when checking path parity.
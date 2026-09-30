---
name: Canvas layout engine shared between script and API
description: The doc→Canvas layout builder is extracted and shared — don't re-fork it.
---

The logic that turns a structured doc spec into a Canvas page design is shared between
the provisioning script and the from-doc admin endpoint via one extracted engine.

**Why:** the engine originally lived inline in the provisioning script; the from-doc
endpoint needed the same block-building math. Duplicating it lets the two drift apart.

**How to apply:** any change to how doc specs become Canvas blocks (spacing, block types,
heights, theme handling) belongs in the shared engine, not a copy. Block heights are
computed server-side from the spec, never trusted from the LLM. The multi-page cleanup
pipeline (normalize spacing + remove sample placeholders + equalize card rows) is
likewise shared, idempotent, and self-verifies content preservation before writing.

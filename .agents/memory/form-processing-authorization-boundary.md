---
name: Form processing authorization boundary
description: Security rules for endpoints that turn persisted form submissions into platform records.
---

Form submissions identify persisted work; they do not authorize record mutations. Resolve configuration, lifecycle state, caller identity, and target ownership authoritatively before any legacy or structured side effect.

**Why:** Treating request data or a submission identifier as authority lets anonymous, stale, or redirected processing mutate records the submitter does not own.

**How to apply:** Treat client values as references to reload, not trusted instructions. Bind server-derived identity and authority into internal proofs; delayed paid hops must also match the persisted authority snapshot. Enforce the same ownership rules in old and new processors, and strip answers hidden by persisted rules before resolving targets.

Synthetic invocations that reuse a record writer must also reuse the caller's verified capabilities and visibility-filtered answers; reusing the writer alone does not inherit either boundary.

**Why:** A wrapper can accidentally elevate an ordinary submitter by manufacturing administrator flags, or let stale hidden companion answers satisfy required fields and mutate records.

**How to apply:** Pass the real processing authorization through wrappers, and apply authoritative visibility before building mapped payloads or checking required values.
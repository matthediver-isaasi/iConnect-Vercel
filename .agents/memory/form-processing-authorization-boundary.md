---
name: Form processing authorization boundary
description: Security rules for endpoints that turn persisted form submissions into platform records.
---

Form submissions identify persisted work; they do not authorize record mutations. Resolve configuration, lifecycle state, caller identity, and target ownership authoritatively before any legacy or structured side effect.

**Why:** Treating request data or a submission identifier as authority lets anonymous, stale, or redirected processing mutate records the submitter does not own.

**How to apply:** Treat client values as references to reload, not trusted instructions. Bind server-derived identity and authority into internal proofs; delayed paid hops must also match the persisted authority snapshot. Enforce the same ownership rules in old and new processors, and strip answers hidden by persisted rules before resolving targets.
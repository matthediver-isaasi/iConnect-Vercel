---
name: Nested form-field parity
description: Cross-surface rules for form fields nested inside repeatable or other container fields.
---

Treat nested form fields as a separate discovery scope, not as ordinary top-level fields.

**Why:** Top-level-only field scans can leave nested controls looking correct in the builder while option endpoints reject them, cache keys collide between containers, paid paths skip validation, or exports leak stored IDs. Shared formatting also needs the exact canonical container and row schema rather than a parallel approximation.

**How to apply:** Whenever a form feature introduces nested fields, audit persisted-form lookup, tenant-scoped option resolution, query cache identity, every submission path (including payment/manual), label collection, and detail/CSV/PDF/email/Word output. Derive all readers from the shared schema normalizer.
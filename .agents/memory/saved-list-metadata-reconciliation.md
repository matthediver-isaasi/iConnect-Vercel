---
name: Saved list metadata reconciliation
description: Avoiding destructive saved-view cleanup before permission-pruned list metadata is ready.
---

Do not reconcile saved columns, filters, operators, ordering, or hidden controls against a fallback or partially loaded inventory. Wait for the authoritative permission-pruned server metadata.

**Why:** Early reconciliation treats relationship-backed IDs as stale and permanently drops them. If a user selects a view while metadata loads, a later automatic default restore can also overwrite that explicit choice.

**How to apply:** Gate local/default restoration and persistence on metadata readiness. Queue an early manual selection and mark automatic default restoration consumed so the queued choice wins when metadata arrives.
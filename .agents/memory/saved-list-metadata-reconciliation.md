---
name: Saved list metadata reconciliation
description: Avoiding destructive saved-view cleanup before permission-pruned list metadata is ready.
---

Do not reconcile saved columns, filters, operators, ordering, or hidden controls against a fallback or partially loaded inventory. Wait for the authoritative permission-pruned server metadata.

**Why:** Early reconciliation treats relationship-backed IDs as stale and permanently drops them. If a user selects a view while metadata loads, a later automatic default restore can also overwrite that explicit choice.

**How to apply:** Gate local/default restoration and persistence on metadata readiness. Queue an early manual selection and mark automatic default restoration consumed so the queued choice wins when metadata arrives.

For CRM list startup, distinguish restoring the initial saved view from fetching its results. Briefly lock filters while restoring; do not extend that lock to every subsequent list refresh or unrelated options request.

**Why:** Allowing edits during automatic restoration can overwrite user input or leave startup waiting for a search value the user has already changed. Conversely, waiting for every ancillary option unnecessarily delays core-only results.

**How to apply:** Require authoritative metadata for active saved custom filters, keep unrelated options off the first-result critical path, and allow further filtering once restoration is settled. Preserve explicit error/retry states instead of interpreting a failed settings read as “no saved view.”
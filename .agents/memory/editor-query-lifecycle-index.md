---
name: Editor query lifecycle
description: Index of discovery, pending-query, and saved-metadata lifecycle constraints.
---

- [Save-first discovery](discovery-save-first.md) — invalid drafts must not prevent obtaining a saved identity; keep authenticated tenant transport separate from public hints.
- [Pending detail queries](query-pending-lifecycle.md) — disabled queries remain pending; distinguish unresolved discovery from confirmed missing data.
- [Stable query fallbacks](usequery-default-array-loop.md) — stable fallback arrays prevent synchronization loops.
- [Saved list metadata reconciliation](saved-list-metadata-reconciliation.md) — wait for authorized metadata before reconciling saved choices.
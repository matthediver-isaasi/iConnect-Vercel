---
name: Editor query lifecycle
description: Index of discovery, pending-query, and saved-metadata lifecycle constraints.
---

- [Save-first discovery](discovery-save-first.md) — invalid drafts must not prevent obtaining a saved identity; keep authenticated tenant transport separate from public hints.
- [Pending detail queries](query-pending-lifecycle.md) — disabled queries remain pending; distinguish unresolved discovery from confirmed missing data.
- [Controlled composite pending state](controlled-composite-pending-state.md) — queued sibling edits must drive rendering until the parent acknowledges them.
- [Manual request effects](manual-request-effects.md) — loading state must not invalidate the effect that owns the pending request.
- [Stable query fallbacks](usequery-default-array-loop.md) — stable fallback arrays prevent synchronization loops.
- [Saved list metadata reconciliation](saved-list-metadata-reconciliation.md) — wait for authorized metadata before reconciling saved choices.
- [Saved member layout authority](saved-member-layout-authority.md) — default mandate fields must not override deliberate saved-layout removals.
- [Post-save freshness](editor-postsave-freshness.md) — wait for fresh data before re-hydrating; stale cached drafts can blank saved fields.
- [Destructive dialog defaults](destructive-dialog-defaults.md) — background refresh must never replace an explicit preservation choice with destructive disposal.
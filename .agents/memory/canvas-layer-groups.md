---
name: Canvas layer groups
description: How block grouping in the Canvas Page Editor models group state and persists.
---

# Canvas layer groups (CanvasPageEditor)

Grouping lets 2+ blocks select/move as one unit and show as a collapsible parent in the Layers palette.

## Data model
- `root.groups: [{id, name, collapsed}]` registry + a `groupId` on each block.
- Normalization prunes empty groups and clears dangling `groupId` refs, so a group only exists while it has members.

## Key design decision: group hidden/locked are DERIVED, not stored
Only `name` and `collapsed` live on the group registry. A group is considered hidden only when **every** member is hidden at the current breakpoint, and locked only when **every** member is locked. Toggling group visibility/lock flips all members to the inverse of that derived state.
**Why:** avoids a second source of truth that could disagree with per-block state; members already carry per-breakpoint `hidden` and a `locked` flag.
**How to apply:** never add a stored hidden/locked flag to a group; compute from members. `collapsed` is view-only and must NOT push undo history (set the skip-history ref before toggling).

## Renderer is untouched
The published renderer ignores `groupId`/`groups` entirely — grouping is editor-only metadata, so rendered/published output is unchanged.

## Layers palette reordering
Uses nested SortableContexts: an outer context of top-level items (block ids and `grp:<id>` group containers) and one inner context per group of member ids. A group renders at its top-most member's display position. Rebuild storage order by flattening top-level order (expanding groups into member ids in display order) then reversing (array tail = visually on top). Members can only be reordered within their own group via drag; dragging a member onto a non-member is a no-op.

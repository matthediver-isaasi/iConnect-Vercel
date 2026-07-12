---
name: Canvas Auto-order recursion
description: Which nesting levels the Auto-order accessibility action may reorder, and why.
---

# Canvas Auto-order recursion

The Auto-order action rewrites document (tab/reading) order to match visual
layout with zero visual change. It must recurse into nested container children,
but the choice of which levels to reorder is a correctness/security-of-layout
constraint, not a free choice.

**Rule:** only reorder a level whose container lays children out by absolute
position (free-layout groups). NEVER reorder flow-layout containers
(section/row): flow lays children out BY document order, so reordering them
moves content on the page — the opposite of "zero visual change". Recurse
*into* flow containers, just don't reorder their direct children.

**Why:** v1 canvas is flat, so recursion only matters for v2 flow designs whose
free groups are absolute clusters that can overlap. The top-level array handed
to Auto-order is a flow stack in v2 but free in v1, so callers must tell it
whether the root is flow.

**Edge case that bit us:** the "would Auto-order change anything?" predicate
(drives the toolbar enabled-state) must recurse into ANY non-empty child array,
not only arrays with >1 child. A mismatch can hide several levels down behind
single-child intermediate containers (flow section with one child = a free
group of out-of-order blocks); a >1 guard on the recursion silently disables
the action. Keep the per-level reorder check gated on >1, but never the descent.

**Also:** stacking must be preserved per level (pin z-index only when a reorder
would swap paint order), and the whole pass stays pure/idempotent — unchanged
subtrees keep their original references.

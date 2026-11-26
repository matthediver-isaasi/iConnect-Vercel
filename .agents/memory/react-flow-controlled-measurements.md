---
name: Controlled React Flow measurements
description: Why a mini-map can remain empty while its main graph renders normally.
---

React Flow's mini-map reads dimensions from the controlled user nodes, not just
the measured internal nodes. Retain dimension-change notifications and project
the measurements back onto the display nodes.

**Why:** The funnel builder discarded dimension changes while retaining only
positions and selection. Its main graph rendered, but the mini-map drew no
nodes. Checking only that the mini-map panel existed missed the regression.

**How to apply:** Keep measurements in view-only state, separate from saved
graph/routing and authored positions. Process measurements even when editing is
locked. Browser tests must verify actual mini-map shapes with positive visible
dimensions after loading, editing and arranging, not merely the panel's presence.

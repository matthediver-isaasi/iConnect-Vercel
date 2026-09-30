---
name: Canvas flow (v2) builder edits are first-section-only
description: Why builder drops/edits for flow designs must live in the first section, and how palette drops reach the flow stage
---

For flow (v2 / auto-layout) Canvas designs, the builder's flat editing model
operates ONLY on the FIRST section's children:
- `getRootChildren(design)` returns `sections[0].children` (via the flow
  normalizer), and `setRootChildren` collapses the design down to a single
  section. So `children`, `replaceChildren`, `updateBlock`, `applyGeometry`,
  `selectedBlocks`, etc. in CanvasBuilder can only see/edit nodes in the first
  section. Nodes in other sections (from a v1->v2 conversion) are effectively
  read-only in the builder — a pre-existing limitation, not a regression.

**How to apply:** When inserting/dropping a node in the builder and it must be
selectable + editable, put it in the FIRST section (use `insertFlowNode` with no
sectionId). Targeting a later section renders fine but makes the node
uneditable through the shared handlers.

Palette drag→drop onto the flow stage:
- The drop only fires when an element registers the droppable id
  `canvas-drop-zone` (handleDragEnd gates on `over.id === 'canvas-drop-zone'`).
  CanvasStage (v1) registers it; CanvasFlowEditorStage must register the SAME id
  too or drops silently do nothing.
- Flow nodes auto-layout (stack) — x/y are derived by the engine, so the drop
  handler skips all pointer→stage coordinate math for flow and just appends a
  `createFlowNode(...)` (not `createBlock`, which lacks flow props) via
  `insertFlowNode`. Appending to root children would make the node a sibling of
  the sections, which the engine never lays out.

**Breakpoint-hidden-by-default blocks:** neither v1 nor v2 palette drop may force `desktop: { hidden: false }` in createBlock/createFlowNode overrides — type defaults must win, or mobile-only blocks (hero-carousel-mobile) show on desktop. After drop, if `resolveBlockAtBreakpoint(node, breakpoint).hidden`, switch the editor to the mobile breakpoint.

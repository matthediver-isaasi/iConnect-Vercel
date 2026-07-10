---
name: Canvas flow (auto-layout) model
description: Task 2558 Step-1 foundation — v2 flow document model, shared pure layout engine, autobuild flow emitter; how the pieces fit and the idempotency trap.
---

# Canvas flow (auto-layout) model — Step 1 foundation

The Canvas Builder is being re-architected from absolute X/Y positioning (v1) to a
HYBRID flow model (v2): an ordered section→row→leaf tree where vertical position is
DERIVED from block order + measured/declared height. Sections/elements can opt into
FREE mode (absolute, overlap preserved). Step 1 shipped the data layer only — NO
user-facing change; the builder/renderer still run the v1 path.

**Three pieces, one source of truth:**
- `client/src/lib/canvasDesign.js` — v2 model: `CANVAS_FLOW_VERSION=2`, `LAYOUT_MODES`
  {FLOW,FREE}, ROW/GROUP block types, flow node creators, `isFlowDesign`,
  `normalizeFlowDesign`. `normalizeCanvasDesign` branches at the top:
  `if (isFlowDesign(design)) return normalizeFlowDesign(design)` — the v1 path stays
  byte-identical, so v1 and v2 documents coexist.
- `client/src/lib/canvasFlowLayout.js` — pure, React-free `resolveFlowLayout(design,
  {breakpoint,containerWidth,measured}) → {boxes:{id:{x,y,w,h}}, height}`. Returns
  ABSOLUTE coords. This ONE engine must drive BOTH builder and published page.
- `api/_lib/canvasLayoutEngine.js` — `buildFlowDesign(spec)` / `buildNeutralFlowDesign(spec)`
  autobuild emitter: same spec shape as `buildDesign`, emits a v2 tree (order = truth,
  no x/y cursor), reuses the existing `make*` factories, runs through `normalizeFlowDesign`.

**Why the engine is imported into api from client/src/lib:** precedent is `canvasLinks.js` —
the data layer is React-free so the backend can import it and stay in lockstep with the UI.

**Idempotency trap (bit me):** `Number(null) === 0`, so a normalizer that does
`Number.isFinite(Number(v)) ? Number(v) : null` flips a genuine `null` (height, maxWidth)
to `0` on the SECOND pass — not idempotent. Nullable numeric fields must short-circuit
null/undefined/'' to null BEFORE the Number() coercion. Any new nullable flow prop needs
the same guard, or re-saving a design silently drifts the value.

**Test coverage:** `api/_lib/canvasFlowLayout.test.mjs` (part of `ai-assistant-tests`).
Watch out: `createFlowSection({children})` NORMALIZES (clones) its children, so a test
that mutates the original leaf and expects the tree to change will silently no-op — mutate
`section.children[i]` instead.

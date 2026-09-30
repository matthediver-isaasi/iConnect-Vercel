---
name: v2 flow sections never run SectionRender
description: Flow (v2) container nodes render style-only wrappers; section background features (image/gradient/overlay/fixed-crop) don't apply on flow pages.
---

**Rule:** On v2 flow surfaces (editor `CanvasFlowEditorStage` FlowContainer + public `CanvasFlowStage` FlowNode), container nodes — including SECTION — render only `block.style` (background colour, border, shadow). The registry `SectionRender` component is never invoked for them, so ALL `content.bgType` features (background image, gradient, overlay, and the fixed-crop image fit) are v1-only today.

**Why:** Flow containers are structural; children render as flat siblings, and the container is a paint-only wrapper. Discovered while adding the Fixed Height / Horizontal Crop mode — an architect review flagged the "missing" section support on v2, but it was a pre-existing gap for cover backgrounds too.

**How to apply:** Any new section-background feature is automatically v1-only unless flow container rendering is extended to run section background layers. Don't treat that as a regression of the new feature; scope flow support explicitly.

Related: the fixed-crop recipe (overflow-hidden box + img height:100%/width:auto anchored by left:fx%/translateX(-fx%)) lives in `canvasBackground.js` (`buildFixedCropImgStyle`) and is shared by image blocks and section backgrounds.

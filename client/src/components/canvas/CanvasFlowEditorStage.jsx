import { useEffect, useMemo } from 'react';
import { resolveFlowLayout } from '@/lib/canvasFlowLayout';
import {
  getFlowSections,
  isFlowContainerType,
  resolveBlockHeightCss,
  AUTO_HEIGHT_LEAF_TYPES,
  BLOCK_TYPES,
} from '@/lib/canvasDesign';
import { getBlockDefinition } from './blocks/registry';
import { useFlowMeasurement } from './useFlowMeasurement';

// Task #2569 (Flow Step 3) — the flow (v2) editor stage.
//
// The pure `resolveFlowLayout` engine stacks a flow document off a `measured`
// map of leaf heights but never measures anything itself. This component is the
// live half: it renders every flow node at its resolved absolute box, feeds the
// real rendered leaf heights back into the engine via `useFlowMeasurement`, and
// re-lays-out on every measurement change. The net effect is that editing text,
// expanding an accordion, an image loading in, or switching breakpoint all
// reflow the blocks below in real time — no stored geometry required.
//
// It is rendered ONLY for `isFlowDesign(design)` documents; the v1 absolute
// stage (CanvasStage) is left completely untouched.

// DFS flatten so parents render before their children (children paint on top).
function flattenFlowNodes(design) {
  const out = [];
  const walk = (node, depth) => {
    if (!node || !node.id) return;
    out.push({ node, depth });
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  for (const section of getFlowSections(design)) walk(section, 0);
  return out;
}

function FlowLeaf({ node, box, breakpoint, isSelected, measureRef, onSelect }) {
  const def = getBlockDefinition(node.type);
  if (!def) return null;
  const EditorComponent = def.Editor;
  const style = node.style || {};
  const a11y = node.a11y || {};
  // Parity with the public renderer (CanvasFlowStage `FlowNode`): a leaf is
  // "auto-height" (content-sized and measured back into the engine) ONLY when
  // its type is in AUTO_HEIGHT_LEAF_TYPES (Text / Accordion / Card) and it is
  // not pinned to a fixed height. Every other leaf — including Box, Image
  // (non-fullbleed), Button, Icon, Divider, and absoluteFill leaves (Hero /
  // Hero Carousel) — renders at the engine-resolved height and is NOT measured.
  // Using the same predicate here stops a Box (whose content is empty, so
  // height:auto collapses to just its border/padding) from feeding a collapsed
  // height back into resolveFlowLayout and pulling the blocks below it upward.
  const isAuto =
    AUTO_HEIGHT_LEAF_TYPES.has(node.type) &&
    (node.flow?.heightMode || 'auto') !== 'fixed';
  // absoluteFill leaves (Hero / Hero Carousel) own their internal padding and
  // paint via `absolute inset-0`, so wrapper padding is skipped for them and
  // their content wrapper fills the box.
  const fixedFill = !!def.absoluteFill;
  const heightOverride = resolveBlockHeightCss(node);
  const outlineClass = isSelected
    ? 'outline outline-2 outline-primary outline-offset-[-1px]'
    : '';

  return (
    <div
      role={a11y.role || undefined}
      aria-label={a11y.ariaLabel || undefined}
      ref={isAuto ? measureRef(node.id) : undefined}
      className={`absolute cursor-pointer ${outlineClass}`}
      style={{
        left: box.x,
        top: box.y,
        width: box.w,
        height: isAuto ? 'auto' : (heightOverride || box.h),
        background: style.background,
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        borderStyle: style.borderStyle,
        borderRadius: style.borderRadius,
        opacity: style.opacity,
        zIndex: style.zIndex,
        paddingTop: fixedFill ? 0 : (style.paddingTop || 0),
        paddingRight: fixedFill ? 0 : (style.paddingRight || 0),
        paddingBottom: fixedFill ? 0 : (style.paddingBottom || 0),
        paddingLeft: fixedFill ? 0 : (style.paddingLeft || 0),
        boxSizing: 'border-box',
        overflow: def.allowOverflow ? 'visible' : 'hidden',
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect?.([node.id], e.shiftKey || e.metaKey || e.ctrlKey);
      }}
      data-testid={`canvas-block-${node.id}`}
      data-block-id={node.id}
      data-block-type={node.type}
    >
      {EditorComponent && (
        <div
          className={fixedFill ? 'absolute inset-0 pointer-events-none' : 'w-full pointer-events-none'}
          data-testid={`canvas-block-content-${node.id}`}
        >
          <EditorComponent block={node} breakpoint={breakpoint} asEditor />
        </div>
      )}
    </div>
  );
}

function FlowContainer({ node, box, isSelected, onSelect }) {
  const style = node.style || {};
  const outlineClass = isSelected
    ? 'outline outline-2 outline-primary outline-offset-[-1px]'
    : '';
  return (
    <div
      className={`absolute ${outlineClass}`}
      style={{
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        background: style.background,
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        borderStyle: style.borderStyle,
        borderRadius: style.borderRadius,
        opacity: style.opacity,
        boxSizing: 'border-box',
        // Containers are visual grouping only; clicks fall through to the leaf
        // blocks stacked on top of them.
        pointerEvents: 'none',
      }}
      data-testid={`canvas-flow-container-${node.id}`}
      data-block-id={node.id}
      data-block-type={node.type}
    />
  );
}

export default function CanvasFlowEditorStage({
  design,
  breakpoint = 'desktop',
  canvasWidth,
  canvasHeight,
  selectedIds = [],
  onSelect,
  onHeightChange,
}) {
  // Reset + re-measure whenever the breakpoint (and thus the container width)
  // changes, so heights taken at one width never leak into another.
  const { measured, measureRef } = useFlowMeasurement(breakpoint);

  const { boxes, height } = useMemo(
    () => resolveFlowLayout(design, { breakpoint, containerWidth: canvasWidth, measured }),
    [design, breakpoint, canvasWidth, measured],
  );

  const nodes = useMemo(() => flattenFlowNodes(design), [design]);

  // Report the resolved page height up so the builder can size the stage /
  // rulers to the reflowed content. Done in an effect (not during render) so it
  // never updates the parent while this child is rendering.
  useEffect(() => {
    if (typeof onHeightChange === 'function') onHeightChange(height);
  }, [height, onHeightChange]);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const clearSelection = (e) => {
    if (e.target === e.currentTarget) onSelect?.([]);
  };

  return (
    <div
      className="relative bg-white"
      style={{ width: canvasWidth, height: Math.max(height, canvasHeight || 0) }}
      onPointerDown={clearSelection}
      data-testid="canvas-flow-stage"
    >
      {nodes.map(({ node }) => {
        const box = boxes[node.id];
        if (!box) return null; // hidden at this breakpoint
        if (isFlowContainerType(node.type)) {
          return (
            <FlowContainer
              key={node.id}
              node={node}
              box={box}
              isSelected={selected.has(node.id)}
              onSelect={onSelect}
            />
          );
        }
        return (
          <FlowLeaf
            key={node.id}
            node={node}
            box={box}
            breakpoint={breakpoint}
            isSelected={selected.has(node.id)}
            measureRef={measureRef}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
}

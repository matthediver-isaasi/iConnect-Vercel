import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import useEdgeAutoScroll from './useEdgeAutoScroll';
import { Group as GroupIcon, Ungroup as UngroupIcon, EyeOff as EyeOffIcon } from 'lucide-react';
import { resolveBlockAtBreakpoint, blockIsFullWidthLike, clampGeomToStage, BLOCK_TYPES, resolveBoxShadowCss, resolveBleedBorderRadius, resolveWrapperBackground } from '@/lib/canvasDesign';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { getBlockDefinition } from './blocks/registry';
import { AccordionReflowProvider, useAccordionReflow } from './AccordionReflowContext';
import { TooltipProvider } from '@/components/ui/tooltip';

const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
// Full-width blocks only allow vertical resize; horizontal handles are
// hidden because width is pinned to the canvas at the current breakpoint.
const FULL_WIDTH_RESIZE_HANDLES = ['n', 's'];
// Width-resize-only blocks (auto-height text) expose only the horizontal
// handles; vertical resize is dropped so it can't fight content-driven height.
const WIDTH_ONLY_RESIZE_HANDLES = ['e', 'w'];
// Cards keep full horizontal (width) AND vertical (grow) resize: vertical drag
// only ever grows the card beyond its natural content height (clamped in the
// resize handler); width is free. Corner handles are omitted so a drag is
// unambiguously one axis.
const CARD_RESIZE_HANDLES = ['n', 's', 'e', 'w'];

// Task #2609 — group focus (isolation) mode z-ordering. The dark scrim sits
// above all normal blocks; focused group members are lifted above the scrim so
// they stay interactive and readable. Decorations (anchor tag / reading order)
// already use 9998/9999 so the scrim stays below them.
const FOCUS_SCRIM_Z = 5000;
const FOCUS_MEMBER_Z = 5100;

function snap(value, gridSize) {
  if (!gridSize || gridSize <= 0) return value;
  return Math.round(value / gridSize) * gridSize;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Snap a candidate rect against sibling rects + canvas edges. Returns
// { rect, guides } where guides are { vertical: [x...], horizontal: [y...] }.
function snapToSiblings(rect, siblings, canvasWidth, canvasHeight, tolerance = 6, userGuides = { vertical: [], horizontal: [] }) {
  const guides = { vertical: [], horizontal: [] };
  let { x, y, w, h } = rect;

  const xCandidates = [
    { value: 0, type: 'edge' },
    { value: canvasWidth, type: 'edge' },
    { value: canvasWidth / 2, type: 'edge' },
    // Task #1665: user-placed ruler guides are first-class snap targets.
    ...((userGuides?.vertical || []).map((v) => ({ value: v, type: 'guide' }))),
  ];
  const yCandidates = [
    { value: 0, type: 'edge' },
    ...(canvasHeight ? [
      { value: canvasHeight, type: 'edge' },
      { value: canvasHeight / 2, type: 'edge' },
    ] : []),
    ...((userGuides?.horizontal || []).map((v) => ({ value: v, type: 'guide' }))),
  ];

  for (const s of siblings) {
    xCandidates.push({ value: s.x, type: 'sib' });
    xCandidates.push({ value: s.x + s.w, type: 'sib' });
    xCandidates.push({ value: s.x + s.w / 2, type: 'sib' });
    yCandidates.push({ value: s.y, type: 'sib' });
    yCandidates.push({ value: s.y + s.h, type: 'sib' });
    yCandidates.push({ value: s.y + s.h / 2, type: 'sib' });
  }

  // Snap left/right/center on X
  const xTargets = [
    { side: 'left', val: x },
    { side: 'right', val: x + w },
    { side: 'center', val: x + w / 2 },
  ];
  let bestX = null;
  for (const t of xTargets) {
    for (const c of xCandidates) {
      const diff = c.value - t.val;
      if (Math.abs(diff) <= tolerance) {
        if (!bestX || Math.abs(diff) < Math.abs(bestX.diff)) {
          bestX = { diff, line: c.value };
        }
      }
    }
  }
  if (bestX) {
    x += bestX.diff;
    guides.vertical.push(bestX.line);
  }

  // Snap top/bottom/middle on Y
  const yTargets = [
    { side: 'top', val: y },
    { side: 'bottom', val: y + h },
    { side: 'middle', val: y + h / 2 },
  ];
  let bestY = null;
  for (const t of yTargets) {
    for (const c of yCandidates) {
      const diff = c.value - t.val;
      if (Math.abs(diff) <= tolerance) {
        if (!bestY || Math.abs(diff) < Math.abs(bestY.diff)) {
          bestY = { diff, line: c.value };
        }
      }
    }
  }
  if (bestY) {
    y += bestY.diff;
    guides.horizontal.push(bestY.line);
  }

  return { rect: { x, y, w, h }, guides };
}

// Task #1665: snap a resize candidate's moving edges to user ruler guides.
// Only the edges implied by `handle` move, so we snap the left/right edge to
// vertical guides and the top/bottom edge to horizontal guides, then re-derive
// the dependent dimension. Returns { rect, guides } where guides highlight the
// lines that were snapped to.
function snapResizeToGuides(handle, rect, userGuides = { vertical: [], horizontal: [] }, tolerance = 6) {
  const out = { ...rect };
  const hi = { vertical: [], horizontal: [] };
  const vert = userGuides?.vertical || [];
  const horz = userGuides?.horizontal || [];
  const nearest = (lines, target) => {
    let best = null;
    for (const g of lines) {
      const diff = g - target;
      if (Math.abs(diff) <= tolerance && (!best || Math.abs(diff) < Math.abs(best.diff))) {
        best = { diff, line: g };
      }
    }
    return best;
  };

  if (handle.includes('w')) {
    const right = out.x + out.w;
    const b = nearest(vert, out.x);
    if (b) { out.x = b.line; out.w = Math.max(10, right - out.x); hi.vertical.push(b.line); }
  } else if (handle.includes('e')) {
    const b = nearest(vert, out.x + out.w);
    if (b) { out.w = Math.max(10, b.line - out.x); hi.vertical.push(b.line); }
  }

  if (handle.includes('n')) {
    const bottom = out.y + out.h;
    const b = nearest(horz, out.y);
    if (b) { out.y = b.line; out.h = Math.max(10, bottom - out.y); hi.horizontal.push(b.line); }
  } else if (handle.includes('s')) {
    const b = nearest(horz, out.y + out.h);
    if (b) { out.h = Math.max(10, b.line - out.y); hi.horizontal.push(b.line); }
  }

  return { rect: out, guides: hi };
}

function applyResize(handle, start, dx, dy) {
  let { x, y, w, h } = start;
  if (handle.includes('e')) w = start.w + dx;
  if (handle.includes('w')) { x = start.x + dx; w = start.w - dx; }
  if (handle.includes('s')) h = start.h + dy;
  if (handle.includes('n')) { y = start.y + dy; h = start.h - dy; }
  if (w < 10) {
    if (handle.includes('w')) x = start.x + start.w - 10;
    w = 10;
  }
  if (h < 10) {
    if (handle.includes('n')) y = start.y + start.h - 10;
    h = 10;
  }
  return { x, y, w, h };
}

function CanvasBlockView({
  block,
  geom,
  reflowTopOffset,
  reflowSectionGrowth,
  isSelected,
  isAnchor,
  showAllBoxes,
  breakpoint,
  onPointerDownBlock,
  onSelectInteractiveBlock,
  onPointerDownResize,
  onDoubleClickBlock,
  focusZIndex,
  liveHeight,
}) {
  if (geom.hidden) return null;
  const { style, a11y } = block;
  const def = getBlockDefinition(block.type);
  const EditorComponent = def.Editor;
  const isAutoHeight = !!def?.autoHeight;
  const fullWidth = blockIsFullWidthLike(block);
  const noResize = !!def?.noResize;
  // Task #2506: absoluteFill blocks (Hero, Hero Carousel) render their
  // content via `absolute inset-0` — which spans the wrapper's PADDING box —
  // and consume block.style.padding* internally, so wrapper padding is
  // visually inert for them. Worse, with box-sizing:border-box a padding sum
  // larger than the pinned width (e.g. an auto-built hero's 200+200px on the
  // 375px mobile stage) force-expands the border box past the stage edge.
  // Skip wrapper padding for these blocks; their renderers own the padding.
  const skipWrapperPadding = !!def?.absoluteFill;
  // Width-resize-only blocks (auto-height text) let authors control wrapping
  // width but never fight the content-driven height, so only the horizontal
  // handles are offered.
  const widthResizeOnly = !!def?.widthResizeOnly;
  // Cards get vertical grow handles (n/s) in addition to width (e/w).
  const cardGrow = !!def?.cardGrow;
  const cursor = block.locked
    ? 'cursor-not-allowed'
    : (fullWidth ? 'cursor-ns-resize' : 'cursor-move');
  const handles = noResize
    ? []
    : (fullWidth
      ? FULL_WIDTH_RESIZE_HANDLES
      : (cardGrow
        ? CARD_RESIZE_HANDLES
        : (widthResizeOnly ? WIDTH_ONLY_RESIZE_HANDLES : RESIZE_HANDLES)));
  // Anchor (align-to target) gets a thicker, pink outline so users can
  // visually distinguish which block other blocks will align to.
  // When "Show all boxes" is on, every unselected block gets a subtle light
  // outline so authors can verify each element's bounding box. Selected/anchor
  // blocks keep their distinct blue/pink outlines regardless of the toggle.
  const outlineClass = isAnchor
    ? 'outline outline-[3px] outline-pink-500 outline-offset-[-2px]'
    : isSelected
      ? 'outline outline-2 outline-primary outline-offset-[-1px]'
      : showAllBoxes
        ? 'outline outline-1 outline-slate-400/60 outline-offset-[-1px]'
        : '';
  const topOff = reflowTopOffset || 0;
  const sectionGrow = reflowSectionGrowth || 0;
  return (
    <div
      role={a11y.role || undefined}
      aria-label={a11y.ariaLabel || undefined}
      className={`absolute ${cursor} ${outlineClass} ${fullWidth ? 'ring-1 ring-primary/40 ring-inset' : ''}`}
      data-full-width={fullWidth ? 'true' : undefined}
      style={{
        left: geom.x,
        top: geom.y + topOff,
        width: geom.w,
        height: isAutoHeight ? 'auto' : geom.h + sectionGrow,
        // Live feedback while dragging a card's n/s handle: the wrapper is
        // height:auto (autoHeight card), so a floor makes the card box visibly
        // grow with the pointer. The resize handler clamps this to the natural
        // content height, so dragging down snaps to content instead of clipping.
        ...(Number.isFinite(liveHeight) ? { minHeight: liveHeight } : null),
        // Task #3181: gradient/image sections must not paint the wrapper fill
        // (shared resolver — keeps editor, public and symbol preview in sync).
        background: resolveWrapperBackground(block),
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        borderStyle: style.borderStyle,
        // Task #3177: bleeding blocks square off the corners on the bled
        // viewport edge (shared resolver — keeps editor and public in sync).
        borderRadius: resolveBleedBorderRadius(block),
        opacity: style.opacity,
        boxShadow: resolveBoxShadowCss(style),
        // Task #2609 — focused group members render above the focus scrim.
        zIndex: Number.isFinite(focusZIndex) ? focusZIndex : style.zIndex,
        paddingTop: skipWrapperPadding ? 0 : (style.paddingTop || 0),
        paddingRight: skipWrapperPadding ? 0 : (style.paddingRight || 0),
        paddingBottom: skipWrapperPadding ? 0 : (style.paddingBottom || 0),
        paddingLeft: skipWrapperPadding ? 0 : (style.paddingLeft || 0),
        boxSizing: 'border-box',
        overflow: def.allowOverflow ? 'visible' : 'hidden',
      }}
      onPointerDown={(e) => onPointerDownBlock(e, block.id)}
      onDoubleClick={(e) => onDoubleClickBlock?.(e, block.id)}
      data-testid={`canvas-block-${block.id}`}
      data-block-id={block.id}
      data-cb={block.id}
      data-block-type={block.type}
      data-anchor={isAnchor ? 'true' : undefined}
    >
      {EditorComponent && (
        <div
          className={`${isAutoHeight ? 'w-full' : 'absolute'} ${def.editorInteractive ? 'pointer-events-auto' : 'pointer-events-none'}`}
          // Task #3188: fixed-height content used to mount at `inset-0`, which
          // spans the wrapper's PADDING box — so style.padding* was invisible
          // in the editor while the public renderer (normal flow inside the
          // padding) inset the content. Offset the overlay by the same padding
          // the wrapper applies so both surfaces show the identical content
          // box. Zero padding (and absoluteFill blocks, whose padding is
          // skipped on every surface) keeps the exact inset-0 geometry.
          style={isAutoHeight ? undefined : {
            top: skipWrapperPadding ? 0 : (style.paddingTop || 0),
            right: skipWrapperPadding ? 0 : (style.paddingRight || 0),
            bottom: skipWrapperPadding ? 0 : (style.paddingBottom || 0),
            left: skipWrapperPadding ? 0 : (style.paddingLeft || 0),
          }}
          data-testid={`canvas-block-content-${block.id}`}
        >
          <EditorComponent
            block={block}
            breakpoint={breakpoint}
            asEditor
            onSelectParent={(event) => onSelectInteractiveBlock?.(event, block.id)}
          />
        </div>
      )}
      {isSelected && !block.locked && (
        <>
          {handles.map((h) => (
            <div
              key={h}
              onPointerDown={(e) => { e.stopPropagation(); onPointerDownResize(e, block.id, h); }}
              className="absolute bg-white border-2 border-primary"
              style={{ ...handlePositionStyle(h), width: 10, height: 10, cursor: handleCursor(h) }}
              data-testid={`resize-handle-${block.id}-${h}`}
            />
          ))}
        </>
      )}
    </div>
  );
}


function handlePositionStyle(h) {
  const s = {};
  if (h.includes('n')) s.top = -5;
  if (h.includes('s')) s.bottom = -5;
  if (h.includes('w')) s.left = -5;
  if (h.includes('e')) s.right = -5;
  if (h === 'n' || h === 's') { s.left = 'calc(50% - 5px)'; }
  if (h === 'e' || h === 'w') { s.top = 'calc(50% - 5px)'; }
  return s;
}

function handleCursor(h) {
  const map = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
  return map[h] || 'pointer';
}

// Task #2451/#2460: the display-only tablet/mobile clamp (clampGeomToStage)
// now lives in @/lib/canvasDesign so the editor stage, the published-page
// stylesheet (buildCanvasCss) and the forced-breakpoint preview
// (CanvasPageRenderer) all share the exact same rule and can't drift.
// It never touches stored geometry — drag/resize handlers and the Position
// inspector keep reading/writing the raw per-breakpoint frames, and desktop
// rendering is untouched.

function CanvasStageInner({
  blocks,
  selectedIds,
  anchorId,
  breakpoint,
  canvasWidth,
  canvasHeight,
  gridSize = 8,
  showGrid = true,
  showAllBoxes = false,
  zoom = 1,
  showReadingOrder = false,
  userGuides = { vertical: [], horizontal: [] },
  issuesByBlock,
  onSelect,
  onApplyGeometry, // (updates: { [id]: { x, y, w, h } }) => void  (commits to history)
  onMarqueeSelect, // (ids: string[], additive: boolean) => void
  onPreviewBottomChange, // (maxBottomY: number) => void  (live drag/resize bottom)
  expandSelection, // (ids: string[]) => string[]  expands a selection to include whole groups
  onGroup, // () => void  group current selection
  onUngroup, // () => void  ungroup current selection
  canGroup = false,
  canUngroup = false,
  scrollContainerRef, // ref to the scrollable canvas viewport (the builder's <main>)
  activeGroupId = null, // Task #2609 — id of the group currently in focus mode
  onEnterGroupFocus, // (groupId, blockId) => void
  onExitGroupFocus, // () => void
}) {
  const reflow = useAccordionReflow();
  // Default to identity when no group-expansion is supplied.
  const expand = useCallback(
    (ids) => (typeof expandSelection === 'function' ? expandSelection(ids) : ids),
    [expandSelection],
  );
  const stageRef = useRef(null);
  const autoScroll = useEdgeAutoScroll(scrollContainerRef);
  const [interactionState, setInteractionState] = useState(null);
  // interactionState: { kind: 'drag' | 'resize' | 'marquee', ... }
  const [previewGeoms, setPreviewGeoms] = useState({}); // live preview overrides while dragging

  // Emit live preview bottom Y so the parent can grow the stage in real time
  // during a drag/resize. Cleared to 0 when previewGeoms is empty.
  useEffect(() => {
    if (!onPreviewBottomChange) return;
    let maxBottom = 0;
    for (const id in previewGeoms) {
      const g = previewGeoms[id];
      if (!g) continue;
      const b = (g.y || 0) + (g.h || 0);
      if (b > maxBottom) maxBottom = b;
    }
    onPreviewBottomChange(maxBottom);
  }, [previewGeoms, onPreviewBottomChange]);
  const [guides, setGuides] = useState({ vertical: [], horizontal: [] });
  const [marqueeRect, setMarqueeRect] = useState(null);

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: 'canvas-drop-zone',
    data: { isCanvas: true },
  });

  const setRefs = useCallback((node) => {
    stageRef.current = node;
    setDropRef(node);
  }, [setDropRef]);

  const resolvedBlocks = useMemo(
    () => blocks.map((b) => ({
      block: b,
      // Render-path clamp only (no-op on desktop): snapping siblings and
      // marquee hit-testing also read these geoms so they match the visuals.
      geom: clampGeomToStage(
        resolveBlockAtBreakpoint(b, breakpoint, { canvasWidth }),
        breakpoint,
        canvasWidth,
      ),
    })),
    [blocks, breakpoint, canvasWidth],
  );

  const getStageCoords = useCallback((clientX, clientY) => {
    if (!stageRef.current) return { x: 0, y: 0 };
    const rect = stageRef.current.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / (zoom || 1),
      y: (clientY - rect.top) / (zoom || 1),
    };
  }, [zoom]);

  const selectBlock = useCallback((e, blockId) => {
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return null;

    const shift = e.shiftKey;
    // Expand the clicked block to its whole group (identity when ungrouped),
    // so grouped blocks select and drag as one unit.
    const groupMembers = expand([blockId]);
    let nextSelection = selectedIds;
    const isAlreadySelected = selectedIds.includes(blockId);
    if (shift) {
      const allPresent = groupMembers.every((m) => selectedIds.includes(m));
      nextSelection = allPresent
        ? selectedIds.filter((id) => !groupMembers.includes(id))
        : Array.from(new Set([...selectedIds, ...groupMembers]));
    } else if (!isAlreadySelected) {
      nextSelection = groupMembers;
    }
    onSelect(nextSelection);
    return { block, nextSelection };
  }, [blocks, selectedIds, onSelect, expand]);

  // Interactive editor content (such as Advanced Accordion controls) owns the
  // pointer gesture, but still needs to select its parent Canvas block. Keep
  // this path selection-only so buttons and nested-child selection remain
  // usable instead of accidentally starting a block drag.
  const handleSelectInteractiveBlock = useCallback((e, blockId) => {
    if (e.button !== 0) return;
    selectBlock(e, blockId);
  }, [selectBlock]);

  // ----- Block pointer down: select + start drag -----
  const handlePointerDownBlock = useCallback((e, blockId) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Suppress the browser's native text-selection gesture. Without this,
    // shift-clicking blocks highlights the text between them, and that live
    // native selection makes the browser hijack the first drag as a text-drag
    // (so the move preview is discarded on pointer-up and snaps back).
    e.preventDefault();
    const selection = selectBlock(e, blockId);
    if (!selection) return;
    const { block, nextSelection } = selection;

    if (block.locked) return;
    // Start drag for all currently-(post-select)-selected blocks except locked
    const idsToDrag = nextSelection.filter((id) => {
      const b = blocks.find((bb) => bb.id === id);
      return b && !b.locked;
    });
    if (idsToDrag.length === 0) return;

    const start = getStageCoords(e.clientX, e.clientY);
    const initialGeoms = {};
    for (const id of idsToDrag) {
      const b = blocks.find((bb) => bb.id === id);
      initialGeoms[id] = resolveBlockAtBreakpoint(b, breakpoint, { canvasWidth });
    }
    // Safeguard: drop any residual native text selection so it can't hijack
    // the initial drag as a text-drag and cause the move to snap back.
    try { window.getSelection?.()?.removeAllRanges?.(); } catch {}
    setInteractionState({
      kind: 'drag',
      ids: idsToDrag,
      start,
      initialGeoms,
      hasMoved: false,
    });
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
  }, [blocks, selectBlock, getStageCoords, breakpoint, canvasWidth]);

  // Task #2609 — double-clicking a grouped block enters focus mode for its
  // group and selects just that member. Double-clicking an ungrouped block is
  // a no-op (existing behaviour unchanged).
  const handleDoubleClickBlock = useCallback((e, blockId) => {
    const block = blocks.find((b) => b.id === blockId);
    if (!block || !block.groupId) return;
    e.stopPropagation();
    onEnterGroupFocus?.(block.groupId, blockId);
  }, [blocks, onEnterGroupFocus]);

  // Right-clicking a block selects it (and its group) before the context
  // menu opens so Group/Ungroup act on the expected target.
  const handleContextMenuBlock = useCallback((blockId) => {
    if (!selectedIds.includes(blockId)) {
      onSelect(expand([blockId]));
    }
  }, [selectedIds, onSelect, expand]);

  // ----- Resize handle pointer down -----
  const handlePointerDownResize = useCallback((e, blockId, handle) => {
    if (e.button !== 0) return;
    const block = blocks.find((b) => b.id === blockId);
    if (!block || block.locked) return;
    const start = getStageCoords(e.clientX, e.clientY);
    const geom = resolveBlockAtBreakpoint(block, breakpoint, { canvasWidth });
    const def = getBlockDefinition(block.type);
    // Cards may only GROW vertically past their natural content height. Capture
    // that content floor now (it doesn't change mid-drag) so the resize handler
    // can clamp without reading the live reflow context.
    const cardGrow = !!def?.cardGrow;
    const contentFloor = cardGrow && reflow
      ? reflow.getContentHeight(blockId)
      : undefined;
    setInteractionState({
      kind: 'resize',
      id: blockId,
      handle,
      start,
      initialGeom: geom,
      fullWidth: blockIsFullWidthLike(block),
      cardGrow,
      contentFloor: Number.isFinite(contentFloor) ? contentFloor : undefined,
    });
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
  }, [blocks, getStageCoords, breakpoint, canvasWidth, reflow]);

  // ----- Stage background pointer down: clear selection + marquee start -----
  const handleStagePointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return;
    const start = getStageCoords(e.clientX, e.clientY);
    if (!e.shiftKey) onSelect([]);
    setInteractionState({
      kind: 'marquee',
      start,
      current: start,
      additive: e.shiftKey,
    });
  }, [getStageCoords, onSelect]);

  // ----- Global pointer move/up handlers -----
  useEffect(() => {
    if (!interactionState) return;
    // Process a pointer position into the live preview. Extracted so the
    // auto-scroll loop can re-run it against the same client point while the
    // view scrolls (the stage's bounding rect moves, so getStageCoords yields
    // new stage coords from the unchanged client coords).
    const processPointer = (clientX, clientY) => {
      const cur = getStageCoords(clientX, clientY);
      if (interactionState.kind === 'drag') {
        const dxRaw = cur.x - interactionState.start.x;
        const dy = cur.y - interactionState.start.y;
        const previews = {};
        let appliedGuides = { vertical: [], horizontal: [] };

        // If every dragged block is full-width, horizontal motion is
        // disabled — pin dx to 0 so neither geometry nor snap guides
        // move sideways.
        const allFullWidth = interactionState.ids.every((id) => {
          const b = blocks.find((bb) => bb.id === id);
          return b && blockIsFullWidthLike(b);
        });

        // Full-width blocks keep their x locked; only the remaining "movable"
        // blocks participate in horizontal movement and in the shared clamp.
        // Locked blocks must never influence how far the rest of the group
        // may slide, or their presence would distort the group's layout.
        const movableIds = interactionState.ids.filter((id) => {
          const b = blocks.find((bb) => bb.id === id);
          return b && !blockIsFullWidthLike(b);
        });

        // Treat a drag as "pure vertical" when the pointer has barely moved
        // sideways. In that case we suppress ALL horizontal snapping (grid +
        // sibling/edge) so grid alignment can't inject a uniform sideways
        // nudge into the whole group — the group's finalDx stays exactly 0.
        const horizontalIntent = !allFullWidth && Math.abs(dxRaw) > 1;
        const dx = horizontalIntent ? dxRaw : 0;

        // Compute snap for first dragged block; apply same delta to rest
        const firstId = interactionState.ids[0];
        const firstInitial = interactionState.initialGeoms[firstId];
        const candidate = {
          x: firstInitial.x + dx,
          y: firstInitial.y + dy,
          w: firstInitial.w,
          h: firstInitial.h,
        };
        // Grid snap — y always; x only when there is real horizontal intent.
        candidate.y = snap(candidate.y, gridSize);
        if (horizontalIntent) candidate.x = snap(candidate.x, gridSize);

        // Sibling/edge snap. We always run it for the vertical (y) guides but
        // only accept its horizontal (x) result when the user is actually
        // dragging sideways.
        const siblings = resolvedBlocks
          .filter(({ block }) => !interactionState.ids.includes(block.id))
          .map(({ geom }) => geom);
        const { rect: snappedRect, guides: g } = snapToSiblings(
          candidate, siblings, canvasWidth, canvasHeight, 6, userGuides,
        );
        candidate.y = snappedRect.y;
        if (horizontalIntent) {
          candidate.x = snappedRect.x;
          appliedGuides = g;
        } else {
          // Vertical-only (or all-full-width) drag: keep x fixed, drop any
          // vertical (x) guides so we don't flash a sideways snap line.
          appliedGuides = { vertical: [], horizontal: g.horizontal };
        }

        let finalDx = horizontalIntent ? candidate.x - firstInitial.x : 0;
        const finalDy = candidate.y - firstInitial.y;

        // Clamp the selection as a rigid whole. Derive the allowable dx range
        // from the bounding box of the movable blocks versus [0, canvasWidth],
        // then apply one shared clamped delta to every block. This keeps
        // relative positions identical even when the group is dragged against
        // or past a page edge (per-element clamping was the source of drift).
        if (movableIds.length > 0) {
          let minX = Infinity;
          let maxRight = -Infinity;
          for (const id of movableIds) {
            const init = interactionState.initialGeoms[id];
            if (init.x < minX) minX = init.x;
            if (init.x + init.w > maxRight) maxRight = init.x + init.w;
          }
          const minDx = -minX;                    // left edge can't cross 0
          const maxDx = canvasWidth - maxRight;   // right edge can't cross canvasWidth
          // When the selection is wider than the canvas, maxDx < minDx; using
          // min/max here keeps the clamp valid without distorting layout.
          finalDx = clamp(finalDx, Math.min(minDx, maxDx), Math.max(minDx, maxDx));
        }

        for (const id of interactionState.ids) {
          const init = interactionState.initialGeoms[id];
          const b = blocks.find((bb) => bb.id === id);
          const lockX = blockIsFullWidthLike(b);
          previews[id] = {
            x: lockX ? init.x : init.x + finalDx,
            y: Math.max(0, init.y + finalDy),
            w: init.w,
            h: init.h,
          };
        }
        setPreviewGeoms(previews);
        setGuides(appliedGuides);
        if (!interactionState.hasMoved && (Math.abs(dxRaw) > 1 || Math.abs(dy) > 1)) {
          setInteractionState((s) => s ? { ...s, hasMoved: true } : s);
        }
      } else if (interactionState.kind === 'resize') {
        const dx = interactionState.fullWidth ? 0 : (cur.x - interactionState.start.x);
        const dy = cur.y - interactionState.start.y;
        let next = applyResize(interactionState.handle, interactionState.initialGeom, dx, dy);
        // Grid-snap ONLY the axis the active handle actually moves. Snapping the
        // untouched axis rounds a non-grid-aligned block to the nearest grid line
        // on the very first pointer move, producing a perpendicular "nudge".
        // Leaving that axis at its original (applyResize-passthrough) value keeps
        // it exactly where it was.
        const resizesX = /[ew]/.test(interactionState.handle);
        const resizesY = /[ns]/.test(interactionState.handle);
        if (interactionState.fullWidth) {
          // Force x/w back to the pinned values regardless of handle.
          next.x = interactionState.initialGeom.x;
          next.w = interactionState.initialGeom.w;
        } else if (resizesX) {
          next.x = snap(next.x, gridSize);
          next.w = Math.max(10, snap(next.w, gridSize));
        }
        if (resizesY) {
          next.y = snap(next.y, gridSize);
          next.h = Math.max(10, snap(next.h, gridSize));
        }
        // Task #1665: snap the moving edges to user guides. Full-width blocks
        // keep x/w pinned, so only the vertical (n/s) edges may snap.
        const resizeHandle = interactionState.fullWidth
          ? interactionState.handle.replace(/[ew]/g, '')
          : interactionState.handle;
        const { rect: gr, guides: gg } = snapResizeToGuides(resizeHandle, next, userGuides);
        next = gr;
        // Card vertical resize can only GROW past natural content height — never
        // shrink below it (which would clip the content). Clamp the height up to
        // the captured content floor; when dragging the top (n) edge, keep the
        // bottom edge pinned so the clamp doesn't drift the card upward.
        if (
          interactionState.cardGrow &&
          Number.isFinite(interactionState.contentFloor) &&
          /[ns]/.test(interactionState.handle) &&
          next.h < interactionState.contentFloor
        ) {
          if (interactionState.handle.includes('n')) {
            next.y = interactionState.initialGeom.y + interactionState.initialGeom.h - interactionState.contentFloor;
          }
          next.h = interactionState.contentFloor;
        }
        setPreviewGeoms({ [interactionState.id]: next });
        setGuides(gg);
      } else if (interactionState.kind === 'marquee') {
        setInteractionState((s) => s ? { ...s, current: cur } : s);
        const x = Math.min(interactionState.start.x, cur.x);
        const y = Math.min(interactionState.start.y, cur.y);
        const w = Math.abs(cur.x - interactionState.start.x);
        const h = Math.abs(cur.y - interactionState.start.y);
        setMarqueeRect({ x, y, w, h });
      }
    };

    const handleMove = (e) => {
      // Edge auto-scroll while dragging blocks, drawing a marquee selection, or
      // resizing a block. The loop re-runs processPointer with the same client
      // coords after each scroll step so the dragged block / resize preview /
      // marquee rect keeps tracking the pointer as the view moves.
      if (
        interactionState.kind === 'drag' ||
        interactionState.kind === 'resize' ||
        interactionState.kind === 'marquee'
      ) {
        autoScroll.update(e.clientX, e.clientY, () => processPointer(e.clientX, e.clientY));
      }
      processPointer(e.clientX, e.clientY);
    };

    const handleUp = () => {
      autoScroll.stop();
      if (interactionState.kind === 'drag') {
        if (interactionState.hasMoved) {
          onApplyGeometry(previewGeoms);
        }
        setPreviewGeoms({});
        setGuides({ vertical: [], horizontal: [] });
      } else if (interactionState.kind === 'resize') {
        if (Object.keys(previewGeoms).length > 0) {
          // A vertical card resize commits an explicit author height: flag the
          // block so the reflow context treats the stored height as a floor
          // (the card grows to it and never shrinks below content). Width-only
          // (e/w) card resizes leave the card content-driven (no flag).
          const flags = {};
          if (interactionState.cardGrow && /[ns]/.test(interactionState.handle)) {
            flags.manualHeight = true;
          }
          // A horizontal (e/w) resize commits an explicit author width: flag it
          // so an autoSize block (Button / CTA) won't snap back to its
          // text-driven width on the next ResizeObserver tick (Task #2675). The
          // flag is ignored by all non-autoSize blocks.
          if (/[ew]/.test(interactionState.handle)) {
            flags.manualWidth = true;
          }
          if (Object.keys(flags).length > 0) {
            const pg = previewGeoms[interactionState.id];
            onApplyGeometry({ [interactionState.id]: { ...pg, ...flags } });
          } else {
            onApplyGeometry(previewGeoms);
          }
        }
        setPreviewGeoms({});
      } else if (interactionState.kind === 'marquee' && marqueeRect) {
        const intersecting = resolvedBlocks
          .filter(({ geom }) =>
            geom.x < marqueeRect.x + marqueeRect.w &&
            geom.x + geom.w > marqueeRect.x &&
            geom.y < marqueeRect.y + marqueeRect.h &&
            geom.y + geom.h > marqueeRect.y &&
            !geom.hidden,
          )
          .map(({ block }) => block.id);
        if (intersecting.length > 0 || !interactionState.additive) {
          onMarqueeSelect(intersecting, interactionState.additive);
        }
        setMarqueeRect(null);
      }
      setInteractionState(null);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      // NOTE: do NOT stop the auto-scroll loop here. This effect re-runs on
      // every preview update during a drag (previewGeoms is a dependency), so
      // stopping here would tear the RAF loop down each frame and break
      // continuous scrolling while the pointer is held still at an edge. The
      // loop lives in refs inside useEdgeAutoScroll (independent of renders)
      // and is stopped only on real interaction end (handleUp) or on unmount
      // (the hook's own cleanup).
    };
  }, [interactionState, previewGeoms, marqueeRect, resolvedBlocks, blocks, canvasWidth, canvasHeight, gridSize, getStageCoords, onApplyGeometry, onMarqueeSelect, userGuides, autoScroll]);

  const gridStyle = showGrid ? {
    backgroundImage: `linear-gradient(to right, rgba(148,163,184,0.18) 1px, transparent 1px),
                      linear-gradient(to bottom, rgba(148,163,184,0.18) 1px, transparent 1px)`,
    backgroundSize: `${gridSize}px ${gridSize}px`,
  } : {};

  // Adjust editor stage height symmetrically with signed reflow growth:
  // - growth > 0: stage grows so expanded blocks below canvasHeight are visible
  // - growth < 0: stage shrinks so there is no trailing whitespace after collapse
  // The editor uses only minHeight (no CSS height), so signed adjustment suffices.
  const reflowGrowth = reflow ? reflow.getTotalGrowth() : 0;
  const effectiveMinHeight = Math.max(0, canvasHeight + reflowGrowth);

  return (
    <div
      ref={setRefs}
      className={`relative bg-white select-none ${isOver ? 'ring-2 ring-primary ring-inset' : ''}`}
      style={{ width: canvasWidth, minHeight: effectiveMinHeight, ...gridStyle }}
      onPointerDown={handleStagePointerDown}
      data-testid="canvas-stage"
      data-breakpoint={breakpoint}
    >
      {resolvedBlocks.map(({ block, geom }, index) => {
        const preview = previewGeoms[block.id];
        // Preview geoms are derived from the raw stored frames, so re-clamp
        // the merged result to keep the wrapper inside the stage mid-drag too.
        const effective = preview
          ? clampGeomToStage({ ...geom, ...preview }, breakpoint, canvasWidth)
          : geom;
        // Live wrapper growth only while dragging THIS card's n/s handle.
        const liveHeight = (
          interactionState?.kind === 'resize' &&
          interactionState.id === block.id &&
          interactionState.cardGrow &&
          /[ns]/.test(interactionState.handle)
        ) ? effective.h : undefined;
        // Use the stored (non-preview) y for reflow offset computation so that
        // dragging an accordion doesn't confuse which blocks are "above" it.
        const reflowTopOffset = reflow ? reflow.getOffset(block.id, geom.y) : 0;
        // Section blocks grow/shrink by the net delta of accordions inside them.
        const reflowSectionGrowth = (block.type === BLOCK_TYPES.SECTION && reflow)
          ? reflow.getSectionGrowth(block, geom)
          : 0;
        const blockIssues = issuesByBlock?.get?.(block.id) || [];
        const sev = blockIssues.some((i) => i.severity === 'error')
          ? 'error'
          : blockIssues.some((i) => i.severity === 'warning')
            ? 'warning'
            : null;
        // Effective rendered top (used for overlay positioning)
        const renderedTop = effective.y + reflowTopOffset;
        // Task #2609 — while a group is focused, only its members stay lifted
        // above the scrim (and keep their decorations); everything else is
        // dimmed and non-interactive beneath it.
        const isFocusMember = !!activeGroupId && block.groupId === activeGroupId;
        const focusZIndex = isFocusMember ? FOCUS_MEMBER_Z + index : undefined;
        const showDecorations = !activeGroupId || isFocusMember;
        return (
          <div key={block.id} onContextMenu={() => handleContextMenuBlock(block.id)}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div>
                  <CanvasBlockView
                    block={block}
                    geom={effective}
                    reflowTopOffset={reflowTopOffset}
                    reflowSectionGrowth={reflowSectionGrowth}
                    breakpoint={breakpoint}
                    isSelected={selectedIds.includes(block.id)}
                    isAnchor={anchorId === block.id}
                    showAllBoxes={showAllBoxes}
                    onPointerDownBlock={handlePointerDownBlock}
                    onSelectInteractiveBlock={handleSelectInteractiveBlock}
                    onPointerDownResize={handlePointerDownResize}
                    onDoubleClickBlock={handleDoubleClickBlock}
                    focusZIndex={focusZIndex}
                    liveHeight={liveHeight}
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent data-testid={`context-menu-block-${block.id}`}>
                <ContextMenuItem
                  disabled={!canGroup}
                  onClick={() => onGroup?.()}
                  data-testid={`context-group-${block.id}`}
                >
                  <GroupIcon className="w-4 h-4 mr-2" />
                  Group
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!canUngroup}
                  onClick={() => onUngroup?.()}
                  data-testid={`context-ungroup-${block.id}`}
                >
                  <UngroupIcon className="w-4 h-4 mr-2" />
                  Ungroup
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {showDecorations && !effective.hidden && anchorId === block.id && (
              <div
                className="absolute pointer-events-none bg-pink-500 text-white rounded-md text-[10px] font-bold uppercase tracking-wide"
                style={{
                  left: effective.x + 4,
                  top: renderedTop + effective.h + 4,
                  padding: '2px 6px',
                  zIndex: 9998,
                }}
                data-testid={`anchor-tag-${block.id}`}
              >
                Anchor
              </div>
            )}
            {showDecorations && !effective.hidden && sev && (
              <div
                className={`absolute pointer-events-none rounded-full border ${
                  sev === 'error'
                    ? 'bg-destructive text-white border-destructive'
                    : 'bg-warning text-warning-foreground border-warning/50'
                }`}
                style={{
                  left: effective.x + effective.w - 18,
                  top: renderedTop - 8,
                  width: 16,
                  height: 16,
                  fontSize: 11,
                  lineHeight: '14px',
                  textAlign: 'center',
                  fontWeight: 700,
                }}
                title={blockIssues.map((i) => i.message).join('\n')}
                data-testid={`canvas-block-a11y-${block.id}`}
                data-severity={sev}
              >
                !
              </div>
            )}
            {showDecorations && !effective.hidden && showReadingOrder && (
              <div
                className={`absolute pointer-events-none rounded-md text-xs font-bold flex items-center gap-1 ${
                  block.a11y?.ariaHidden
                    ? 'bg-muted text-muted-foreground border border-border'
                    : 'bg-primary text-primary-foreground'
                }`}
                style={{
                  left: effective.x + 4,
                  top: renderedTop + 4,
                  padding: '2px 6px',
                  zIndex: 9999,
                }}
                title={
                  block.a11y?.ariaHidden
                    ? 'Hidden from screen readers (aria-hidden) — this number is not announced by assistive tech.'
                    : 'Announced by screen readers in this order.'
                }
                data-testid={`reading-order-${block.id}`}
                data-aria-hidden={block.a11y?.ariaHidden ? 'true' : 'false'}
              >
                <span className={block.a11y?.ariaHidden ? 'line-through' : undefined}>
                  {index + 1}
                </span>
                {block.a11y?.ariaHidden && <EyeOffIcon className="w-3 h-3" aria-hidden="true" />}
              </div>
            )}
          </div>
        );
      })}

      {/* Task #2609 — focus (isolation) mode scrim. Sits above non-focused
          blocks (dimming + blocking interaction) but below the focused group's
          lifted members. Clicking it exits focus mode. */}
      {activeGroupId && (
        <div
          className="absolute inset-0 bg-black/40"
          style={{ zIndex: FOCUS_SCRIM_Z }}
          onPointerDown={(e) => { e.stopPropagation(); onExitGroupFocus?.(); }}
          data-testid="canvas-focus-scrim"
        />
      )}

      {/* Alignment guides */}
      {guides.vertical.map((x, i) => (
        <div
          key={`v-${i}`}
          className="absolute pointer-events-none"
          style={{ left: x, top: 0, bottom: 0, width: 1, background: '#ec4899' }}
        />
      ))}
      {guides.horizontal.map((y, i) => (
        <div
          key={`h-${i}`}
          className="absolute pointer-events-none"
          style={{ top: y, left: 0, right: 0, height: 1, background: '#ec4899' }}
        />
      ))}

      {/* Marquee */}
      {marqueeRect && (
        <div
          className="absolute pointer-events-none border border-primary bg-primary/10"
          style={{ left: marqueeRect.x, top: marqueeRect.y, width: marqueeRect.w, height: marqueeRect.h }}
          data-testid="marquee-rect"
        />
      )}

      {/* Empty state */}
      {resolvedBlocks.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center px-6 py-8 rounded-md border border-dashed border-slate-300 bg-slate-50">
            <p className="text-sm font-medium text-slate-700 mb-1">Empty canvas</p>
            <p className="text-xs text-slate-500 max-w-xs">
              Drag a block from the left palette onto the canvas to get started.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The editor CanvasStage wraps the inner stage with AccordionReflowProvider in
 * `editorMode`. In editor mode the provider is present (so card/accordion blocks
 * can still report their measured heights — used for the card-resize content
 * floor), but all reflow-driven positioning and sizing is disabled: no push-down
 * offset, no card-row equalization, no section auto-grow, no stage growth. The
 * result is a direct "what you place is what you get" surface where dropping or
 * resizing a block never shifts unrelated blocks. The public renderer
 * (CanvasPageRenderer) keeps full reflow by omitting `editorMode`.
 */
export default function CanvasStage(props) {
  const { blocks, breakpoint, canvasWidth, zoom = 1, onCommitAutoHeight, onCommitAutoSize } = props;
  const resolveGeom = useCallback(
    (b) => resolveBlockAtBreakpoint(b, breakpoint, { canvasWidth }),
    [breakpoint, canvasWidth],
  );
  return (
    <TooltipProvider>
      <AccordionReflowProvider blocks={blocks} resolveGeom={resolveGeom} editorMode zoom={zoom} onMeasure={onCommitAutoHeight} onMeasureSize={onCommitAutoSize}>
        <CanvasStageInner {...props} />
      </AccordionReflowProvider>
    </TooltipProvider>
  );
}

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { resolveBlockAtBreakpoint } from '@/lib/canvasDesign';
import { getBlockDefinition } from './blocks/registry';

const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
// Full-width blocks only allow vertical resize; horizontal handles are
// hidden because width is pinned to the canvas at the current breakpoint.
const FULL_WIDTH_RESIZE_HANDLES = ['n', 's'];

function snap(value, gridSize) {
  if (!gridSize || gridSize <= 0) return value;
  return Math.round(value / gridSize) * gridSize;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Snap a candidate rect against sibling rects + canvas edges. Returns
// { rect, guides } where guides are { vertical: [x...], horizontal: [y...] }.
function snapToSiblings(rect, siblings, canvasWidth, canvasHeight, tolerance = 6) {
  const guides = { vertical: [], horizontal: [] };
  let { x, y, w, h } = rect;

  const xCandidates = [
    { value: 0, type: 'edge' },
    { value: canvasWidth, type: 'edge' },
    { value: canvasWidth / 2, type: 'edge' },
  ];
  const yCandidates = [
    { value: 0, type: 'edge' },
    ...(canvasHeight ? [
      { value: canvasHeight, type: 'edge' },
      { value: canvasHeight / 2, type: 'edge' },
    ] : []),
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
  isSelected,
  isAnchor,
  breakpoint,
  onPointerDownBlock,
  onPointerDownResize,
}) {
  if (geom.hidden) return null;
  const { style, a11y } = block;
  const def = getBlockDefinition(block.type);
  const EditorComponent = def.Editor;
  const fullWidth = !!block.fullWidth;
  const cursor = block.locked
    ? 'cursor-not-allowed'
    : (fullWidth ? 'cursor-ns-resize' : 'cursor-move');
  const handles = fullWidth ? FULL_WIDTH_RESIZE_HANDLES : RESIZE_HANDLES;
  // Anchor (align-to target) gets a thicker, pink outline so users can
  // visually distinguish which block other blocks will align to.
  const outlineClass = isAnchor
    ? 'outline outline-[3px] outline-pink-500 outline-offset-[-2px]'
    : isSelected
      ? 'outline outline-2 outline-primary outline-offset-[-1px]'
      : '';
  return (
    <div
      role={a11y.role || undefined}
      aria-label={a11y.ariaLabel || undefined}
      className={`absolute ${cursor} ${outlineClass} ${fullWidth ? 'ring-1 ring-primary/40 ring-inset' : ''}`}
      data-full-width={fullWidth ? 'true' : undefined}
      style={{
        left: geom.x,
        top: geom.y,
        width: geom.w,
        height: geom.h,
        background: style.background,
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        borderStyle: style.borderStyle,
        borderRadius: style.borderRadius,
        opacity: style.opacity,
        zIndex: style.zIndex,
        paddingTop: style.paddingTop || 0,
        paddingRight: style.paddingRight || 0,
        paddingBottom: style.paddingBottom || 0,
        paddingLeft: style.paddingLeft || 0,
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
      onPointerDown={(e) => onPointerDownBlock(e, block.id)}
      data-testid={`canvas-block-${block.id}`}
      data-block-id={block.id}
      data-block-type={block.type}
      data-anchor={isAnchor ? 'true' : undefined}
    >
      {EditorComponent && (
        <div className="absolute inset-0 pointer-events-none" data-testid={`canvas-block-content-${block.id}`}>
          <EditorComponent block={block} breakpoint={breakpoint} asEditor />
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

export default function CanvasStage({
  blocks,
  selectedIds,
  anchorId,
  breakpoint,
  canvasWidth,
  canvasHeight,
  gridSize = 8,
  showGrid = true,
  zoom = 1,
  showReadingOrder = false,
  issuesByBlock,
  onSelect,
  onApplyGeometry, // (updates: { [id]: { x, y, w, h } }) => void  (commits to history)
  onMarqueeSelect, // (ids: string[], additive: boolean) => void
}) {
  const stageRef = useRef(null);
  const [interactionState, setInteractionState] = useState(null);
  // interactionState: { kind: 'drag' | 'resize' | 'marquee', ... }
  const [previewGeoms, setPreviewGeoms] = useState({}); // live preview overrides while dragging
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
      geom: resolveBlockAtBreakpoint(b, breakpoint, { canvasWidth }),
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

  // ----- Block pointer down: select + start drag -----
  const handlePointerDownBlock = useCallback((e, blockId) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;

    const shift = e.shiftKey;
    let nextSelection = selectedIds;
    const isAlreadySelected = selectedIds.includes(blockId);
    if (shift) {
      nextSelection = isAlreadySelected
        ? selectedIds.filter((id) => id !== blockId)
        : [...selectedIds, blockId];
    } else if (!isAlreadySelected) {
      nextSelection = [blockId];
    }
    onSelect(nextSelection);

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
    setInteractionState({
      kind: 'drag',
      ids: idsToDrag,
      start,
      initialGeoms,
      hasMoved: false,
    });
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
  }, [blocks, selectedIds, onSelect, getStageCoords, breakpoint, canvasWidth]);

  // ----- Resize handle pointer down -----
  const handlePointerDownResize = useCallback((e, blockId, handle) => {
    if (e.button !== 0) return;
    const block = blocks.find((b) => b.id === blockId);
    if (!block || block.locked) return;
    const start = getStageCoords(e.clientX, e.clientY);
    const geom = resolveBlockAtBreakpoint(block, breakpoint, { canvasWidth });
    setInteractionState({
      kind: 'resize',
      id: blockId,
      handle,
      start,
      initialGeom: geom,
      fullWidth: !!block.fullWidth,
    });
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
  }, [blocks, getStageCoords, breakpoint, canvasWidth]);

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
    const handleMove = (e) => {
      const cur = getStageCoords(e.clientX, e.clientY);
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
          return b && b.fullWidth;
        });
        const dx = allFullWidth ? 0 : dxRaw;

        // Compute snap for first dragged block; apply same delta to rest
        const firstId = interactionState.ids[0];
        const firstInitial = interactionState.initialGeoms[firstId];
        const candidate = {
          x: firstInitial.x + dx,
          y: firstInitial.y + dy,
          w: firstInitial.w,
          h: firstInitial.h,
        };
        // Grid snap
        candidate.x = snap(candidate.x, gridSize);
        candidate.y = snap(candidate.y, gridSize);
        // Sibling snap (skip horizontal snap entirely when fully pinned)
        if (!allFullWidth) {
          const siblings = resolvedBlocks
            .filter(({ block }) => !interactionState.ids.includes(block.id))
            .map(({ geom }) => geom);
          const { rect: snappedRect, guides: g } = snapToSiblings(candidate, siblings, canvasWidth, canvasHeight);
          candidate.x = snappedRect.x;
          candidate.y = snappedRect.y;
          appliedGuides = g;
        } else {
          const siblings = resolvedBlocks
            .filter(({ block }) => !interactionState.ids.includes(block.id))
            .map(({ geom }) => geom);
          // Only collect vertical (y) guides; x is fixed at 0.
          const { rect: snappedRect, guides: g } = snapToSiblings(
            { ...candidate, x: firstInitial.x }, siblings, canvasWidth, canvasHeight,
          );
          candidate.y = snappedRect.y;
          appliedGuides = { vertical: [], horizontal: g.horizontal };
        }

        const finalDx = candidate.x - firstInitial.x;
        const finalDy = candidate.y - firstInitial.y;
        for (const id of interactionState.ids) {
          const init = interactionState.initialGeoms[id];
          const b = blocks.find((bb) => bb.id === id);
          const lockX = !!(b && b.fullWidth);
          previews[id] = {
            x: lockX ? init.x : clamp(init.x + finalDx, 0, Math.max(0, canvasWidth - init.w)),
            y: Math.max(0, init.y + finalDy),
            w: init.w,
            h: init.h,
          };
        }
        setPreviewGeoms(previews);
        setGuides(appliedGuides);
        if (!interactionState.hasMoved && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
          setInteractionState((s) => s ? { ...s, hasMoved: true } : s);
        }
      } else if (interactionState.kind === 'resize') {
        const dx = interactionState.fullWidth ? 0 : (cur.x - interactionState.start.x);
        const dy = cur.y - interactionState.start.y;
        let next = applyResize(interactionState.handle, interactionState.initialGeom, dx, dy);
        // grid snap for x/y and w/h edges that changed
        if (!interactionState.fullWidth) {
          next.x = snap(next.x, gridSize);
          next.w = Math.max(10, snap(next.w, gridSize));
        } else {
          // Force x/w back to the pinned values regardless of handle.
          next.x = interactionState.initialGeom.x;
          next.w = interactionState.initialGeom.w;
        }
        next.y = snap(next.y, gridSize);
        next.h = Math.max(10, snap(next.h, gridSize));
        setPreviewGeoms({ [interactionState.id]: next });
        setGuides({ vertical: [], horizontal: [] });
      } else if (interactionState.kind === 'marquee') {
        setInteractionState((s) => s ? { ...s, current: cur } : s);
        const x = Math.min(interactionState.start.x, cur.x);
        const y = Math.min(interactionState.start.y, cur.y);
        const w = Math.abs(cur.x - interactionState.start.x);
        const h = Math.abs(cur.y - interactionState.start.y);
        setMarqueeRect({ x, y, w, h });
      }
    };

    const handleUp = () => {
      if (interactionState.kind === 'drag') {
        if (interactionState.hasMoved) {
          onApplyGeometry(previewGeoms);
        }
        setPreviewGeoms({});
        setGuides({ vertical: [], horizontal: [] });
      } else if (interactionState.kind === 'resize') {
        if (Object.keys(previewGeoms).length > 0) {
          onApplyGeometry(previewGeoms);
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
    };
  }, [interactionState, previewGeoms, marqueeRect, resolvedBlocks, blocks, canvasWidth, canvasHeight, gridSize, getStageCoords, onApplyGeometry, onMarqueeSelect]);

  const gridStyle = showGrid ? {
    backgroundImage: `linear-gradient(to right, rgba(148,163,184,0.18) 1px, transparent 1px),
                      linear-gradient(to bottom, rgba(148,163,184,0.18) 1px, transparent 1px)`,
    backgroundSize: `${gridSize}px ${gridSize}px`,
  } : {};

  return (
    <div
      ref={setRefs}
      className={`relative bg-white ${isOver ? 'ring-2 ring-primary ring-inset' : ''}`}
      style={{ width: canvasWidth, minHeight: canvasHeight, ...gridStyle }}
      onPointerDown={handleStagePointerDown}
      data-testid="canvas-stage"
      data-breakpoint={breakpoint}
    >
      {resolvedBlocks.map(({ block, geom }, index) => {
        const preview = previewGeoms[block.id];
        const effective = preview ? { ...geom, ...preview } : geom;
        const blockIssues = issuesByBlock?.get?.(block.id) || [];
        const sev = blockIssues.some((i) => i.severity === 'error')
          ? 'error'
          : blockIssues.some((i) => i.severity === 'warning')
            ? 'warning'
            : null;
        return (
          <div key={block.id}>
            <CanvasBlockView
              block={block}
              geom={effective}
              breakpoint={breakpoint}
              isSelected={selectedIds.includes(block.id)}
              isAnchor={anchorId === block.id}
              onPointerDownBlock={handlePointerDownBlock}
              onPointerDownResize={handlePointerDownResize}
            />
            {!effective.hidden && anchorId === block.id && (
              <div
                className="absolute pointer-events-none bg-pink-500 text-white rounded-md text-[10px] font-bold uppercase tracking-wide"
                style={{
                  left: effective.x + 4,
                  top: effective.y + effective.h + 4,
                  padding: '2px 6px',
                  zIndex: 9998,
                }}
                data-testid={`anchor-tag-${block.id}`}
              >
                Anchor
              </div>
            )}
            {!effective.hidden && sev && (
              <div
                className={`absolute pointer-events-none rounded-full border ${
                  sev === 'error'
                    ? 'bg-destructive text-white border-destructive'
                    : 'bg-amber-500 text-white border-amber-500'
                }`}
                style={{
                  left: effective.x + effective.w - 18,
                  top: effective.y - 8,
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
            {!effective.hidden && showReadingOrder && (
              <div
                className="absolute pointer-events-none bg-primary text-primary-foreground rounded-md text-xs font-bold"
                style={{
                  left: effective.x + 4,
                  top: effective.y + 4,
                  padding: '2px 6px',
                  zIndex: 9999,
                }}
                data-testid={`reading-order-${block.id}`}
              >
                {index + 1}
              </div>
            )}
          </div>
        );
      })}

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

import { useState, useRef, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Save,
  Undo2,
  Redo2,
  Trash2,
  Copy,
  Monitor,
  Tablet,
  Smartphone,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignVerticalDistributeCenter,
  AlignHorizontalDistributeCenter,
  Grid3x3,
  Ruler,
  Eraser,
  Square,
  ZoomIn,
  ZoomOut,
  Maximize2,
  ListOrdered,
  Accessibility,
  Group as GroupIcon,
  Ungroup as UngroupIcon,
  Layers,
  Wand2,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  createBlock,
  getBlockDefaults,
  normalizeCanvasDesign,
  resolveBlockAtBreakpoint,
  setBlockBp,
  clearBpOverride,
  getRootChildren,
  setRootChildren,
  getGroups,
  setGroups,
  getCanvasGuides,
  setCanvasGuides,
  getCanvasGuidePositions,
  createGroup,
  ungroup,
  BREAKPOINT_WIDTHS,
  BLOCK_TYPES,
  stageHeightForBreakpoint,
  symbolContentExtent,
} from '@/lib/canvasDesign';
import CanvasPalette from './CanvasPalette';
import CanvasStage from './CanvasStage';
import { getBlockDefinition } from './blocks/registry';
import useEdgeAutoScroll from './useEdgeAutoScroll';
import CanvasGuidesOverlay from './CanvasGuides';
import CanvasInspector from './CanvasInspector';
import { CanvasAnchorProvider } from './CanvasAnchorContext';
import { CanvasEditorPageProvider } from './CanvasEditorPageContext';
import { CanvasSymbolsProvider, useCanvasSymbolsData } from './CanvasSymbolsContext';
import CanvasLayers from './CanvasLayers';
import CanvasA11yPanel from './CanvasA11yPanel';
import CanvasFloatingPanel from './CanvasFloatingPanel';
import {
  auditCanvasDesign,
  issuesByBlock as buildIssuesByBlock,
  suggestHeadingLevel,
  headingFieldFor,
} from '@/lib/canvasA11y';
import {
  generateAutoLayout,
  hasResponsiveGeometryOverrides,
} from '@/lib/canvasAutoLayout';

const BREAKPOINTS = [
  { id: 'desktop', label: 'Desktop', icon: Monitor },
  { id: 'tablet', label: 'Tablet', icon: Tablet },
  { id: 'mobile', label: 'Mobile', icon: Smartphone },
];

const STAGE_MIN_HEIGHT = 800;

const RULER_SIZE = 20;

const EMPTY_GUIDES = { vertical: [], horizontal: [] };

function snapGuideValue(v, gridSize) {
  if (!gridSize || gridSize <= 1) return Math.round(v);
  return Math.round(v / gridSize) * gridSize;
}

function CanvasRulers({ width, height, gridSize, zoom = 1, onCreateGuide, children }) {
  // Tick every gridSize*N where N is chosen to keep ticks readable at zoom.
  const baseStep = Math.max(gridSize, 8);
  const labelEvery = Math.max(1, Math.round(40 / (baseStep * zoom)));
  const step = baseStep;
  const labelStep = step * labelEvery;
  const widthScaled = width * zoom;
  const heightScaled = height * zoom;
  // Regular ticks stop BEFORE the stage edge — a dedicated edge tick with the
  // exact stage dimension ("375" on mobile, "1200" desktop, …) is always
  // appended at width/height below, so the ruler visibly ends at the true
  // stage size at every zoom level.
  const hTicks = [];
  for (let x = 0; x < width; x += step) hTicks.push(x);
  const vTicks = [];
  for (let y = 0; y < height; y += step) vTicks.push(y);
  // Suppress a regular label when it would visually collide with the
  // always-rendered edge label at the current zoom (screen-px thresholds:
  // labels are ~20px wide at the 9px font, plus breathing room).
  const H_EDGE_LABEL_CLEARANCE = 40;
  const V_EDGE_LABEL_CLEARANCE = 22;

  return (
    <div
      className="relative"
      style={{ width: RULER_SIZE + widthScaled, height: RULER_SIZE + heightScaled }}
      data-testid="canvas-rulers"
    >
      {/* Stage content, offset to the right of / below the rulers. */}
      <div className="absolute" style={{ top: RULER_SIZE, left: RULER_SIZE }}>
        {children}
      </div>
      {/* Top ruler wrapper — spans the FULL stage height (pointer-transparent)
          so the sticky ruler inside can stay pinned to the top edge of the
          scroll viewport on vertical scroll, while the wrapper scrolls
          sideways with the content so ticks stay aligned to the blocks. */}
      <div
        className="absolute top-0 pointer-events-none"
        style={{ left: RULER_SIZE, width: widthScaled, height: RULER_SIZE + heightScaled, zIndex: 2 }}
      >
      {/* Top ruler — drag down to create a horizontal guide */}
      <div
        className="sticky top-0 bg-white border-b border-slate-300 overflow-hidden touch-none pointer-events-auto"
        style={{ width: widthScaled, height: RULER_SIZE, cursor: onCreateGuide ? 'row-resize' : 'default' }}
        data-testid="ruler-horizontal"
        onPointerDown={(e) => { if (e.button === 0) onCreateGuide?.('horizontal', e); }}
      >
        {hTicks.map((x) => {
          const isLabel = x % labelStep === 0
            && (width - x) * zoom >= H_EDGE_LABEL_CLEARANCE;
          return (
            <div
              key={`h-${x}`}
              className="absolute bg-slate-400"
              style={{
                left: x * zoom,
                top: isLabel ? RULER_SIZE - 8 : RULER_SIZE - 4,
                width: 1,
                height: isLabel ? 8 : 4,
              }}
            >
              {isLabel && (
                <span
                  className="absolute text-[9px] text-slate-500 leading-none"
                  style={{ left: 2, top: -10, whiteSpace: 'nowrap' }}
                >
                  {x}
                </span>
              )}
            </div>
          );
        })}
        {/* Edge tick + label at the exact stage width. The label hangs to the
            LEFT of the tick (right-anchored) so the ruler's overflow-hidden
            never clips it. */}
        <div
          className="absolute bg-slate-500"
          style={{
            left: Math.max(0, widthScaled - 1),
            top: RULER_SIZE - 10,
            width: 1,
            height: 10,
          }}
          data-testid="ruler-h-edge"
        >
          <span
            className="absolute text-[9px] text-slate-600 font-medium leading-none"
            style={{ right: 2, top: -10, whiteSpace: 'nowrap' }}
          >
            {width}
          </span>
        </div>
      </div>
      </div>
      {/* Left ruler wrapper — spans the FULL stage width (pointer-transparent)
          so the sticky ruler inside can stay pinned to the left edge of the
          scroll viewport on horizontal scroll, while the wrapper scrolls
          vertically with the content so ticks stay aligned to the blocks. */}
      <div
        className="absolute left-0 pointer-events-none"
        style={{ top: RULER_SIZE, width: RULER_SIZE + widthScaled, height: heightScaled, zIndex: 2 }}
      >
      {/* Left ruler — drag right to create a vertical guide */}
      <div
        className="sticky left-0 bg-white border-r border-slate-300 overflow-hidden touch-none pointer-events-auto"
        style={{ width: RULER_SIZE, height: heightScaled, cursor: onCreateGuide ? 'col-resize' : 'default' }}
        data-testid="ruler-vertical"
        onPointerDown={(e) => { if (e.button === 0) onCreateGuide?.('vertical', e); }}
      >
        {vTicks.map((y) => {
          const isLabel = y % labelStep === 0
            && (height - y) * zoom >= V_EDGE_LABEL_CLEARANCE;
          return (
            <div
              key={`v-${y}`}
              className="absolute bg-slate-400"
              style={{
                top: y * zoom,
                left: isLabel ? RULER_SIZE - 8 : RULER_SIZE - 4,
                height: 1,
                width: isLabel ? 8 : 4,
              }}
            >
              {isLabel && (
                <span
                  className="absolute text-[9px] text-slate-500 leading-none"
                  style={{ top: 2, left: -16, width: 14, textAlign: 'right' }}
                >
                  {y}
                </span>
              )}
            </div>
          );
        })}
        {/* Edge tick + label at the exact stage height. The label sits ABOVE
            the tick (bottom-anchored) so the ruler's overflow-hidden never
            clips it. */}
        <div
          className="absolute bg-slate-500"
          style={{
            top: Math.max(0, heightScaled - 1),
            left: RULER_SIZE - 10,
            height: 1,
            width: 10,
          }}
          data-testid="ruler-v-edge"
        >
          <span
            className="absolute text-[9px] text-slate-600 font-medium leading-none"
            style={{ bottom: 2, left: -14, width: 14, textAlign: 'right' }}
          >
            {height}
          </span>
        </div>
      </div>
      </div>
      {/* Corner — pinned to the top-left of the scroll viewport. */}
      <div
        className="sticky top-0 left-0 bg-slate-200 border-r border-b border-slate-300"
        style={{ width: RULER_SIZE, height: RULER_SIZE, zIndex: 3 }}
      />
    </div>
  );
}

const CanvasBuilder = forwardRef(function CanvasBuilder({
  initialDesign,
  breakpoint,
  onBreakpointChange,
  onSave,
  isSaving,
  isDirty: isDirtyProp,
  onDirtyChange,
  extraIssues = [],
  onLocateIssue,
  otherPages = [],
  onUnlinkSymbol,
  micrositeId = null,
}, ref) {
  const [design, setDesignState] = useState(() => normalizeCanvasDesign(initialDesign));
  const [selectedIds, setSelectedIds] = useState([]);
  // Manual anchor override — set via the "Align to" dropdown. Cleared
  // automatically whenever the selection changes so the implicit
  // "last selected = anchor" rule resumes.
  const [manualAnchorId, setManualAnchorId] = useState(null);
  const selectionKey = useMemo(() => selectedIds.join('|'), [selectedIds]);
  useEffect(() => { setManualAnchorId(null); }, [selectionKey]);
  const [activeDragId, setActiveDragId] = useState(null);
  const [activeDragType, setActiveDragType] = useState(null);
  const [showGrid, setShowGrid] = useState(true);
  const [gridSize, setGridSize] = useState(8);
  const [zoom, setZoom] = useState(1);
  const [showReadingOrder, setShowReadingOrder] = useState(false);
  const [showA11yPanel, setShowA11yPanel] = useState(false);
  // Floating, draggable Layers panel (open by default so nothing appears missing).
  // Open/closed state persists per-user via localStorage across editor reloads.
  const [showLayersPanel, setShowLayersPanel] = useState(() => {
    if (typeof window === 'undefined') return true;
    try {
      const raw = window.localStorage.getItem('canvas.layersPanel.open');
      if (raw === null) return true;
      return raw === 'true';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem('canvas.layersPanel.open', String(showLayersPanel));
    } catch {
      // Best-effort persistence; ignore storage errors.
    }
  }, [showLayersPanel]);
  // Task #1665: editor-only ruler guides.
  const [showGuides, setShowGuides] = useState(true);
  // guideDrag holds the immutable descriptor of an in-progress guide drag
  // (kind/orientation/index); guidePreview holds its live value+removing flag.
  // Splitting them keeps the window-listener effect from re-binding on move.
  const [guideDrag, setGuideDrag] = useState(null);
  const [guidePreview, setGuidePreview] = useState(null);
  const guideDragRef = useRef(null);
  const guideAreaRef = useRef(null);
  // Alignment reference frame for the align toolbar buttons:
  //  - 'anchor'    -> last-selected block (Figma/Sketch pattern). With a
  //                   single selection this falls back to canvas bounds
  //                   since there is nothing else to anchor against.
  //  - 'selection' -> bounding box of all selected blocks.
  //  - 'canvas'    -> canvas bounds at the active breakpoint.
  const [alignRef, setAlignRef] = useState('anchor');
  const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
  const zoomIn = () => setZoom((z) => ZOOM_LEVELS.find((l) => l > z + 0.001) ?? z);
  const zoomOut = () => setZoom((z) => [...ZOOM_LEVELS].reverse().find((l) => l < z - 0.001) ?? z);
  const resetZoom = () => setZoom(1);

  // History stacks
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const skipHistoryRef = useRef(false);
  const [, forceHistTick] = useState(0);
  const MAX_HISTORY = 50;

  // Last saved JSON snapshot lives in state so isDirty recomputes when a
  // save succeeds. We also track which initialDesign object identity we
  // already hydrated to avoid clobbering local state on refetches.
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState(
    () => JSON.stringify(normalizeCanvasDesign(initialDesign)),
  );
  const hydratedFromRef = useRef(initialDesign);
  const autosaveTimer = useRef(null);

  // Re-hydrate only when the editor explicitly hands us a different
  // initialDesign object (different page or full reset). Successful
  // autosaves do NOT change initialDesign in the parent, so undo/redo
  // history and uncommitted edits survive across saves.
  useEffect(() => {
    if (initialDesign && hydratedFromRef.current !== initialDesign) {
      const normalized = normalizeCanvasDesign(initialDesign);
      setDesignState(normalized);
      setLastSavedSnapshot(JSON.stringify(normalized));
      undoStack.current = [];
      redoStack.current = [];
      hydratedFromRef.current = initialDesign;
      forceHistTick((n) => n + 1);
    }
  }, [initialDesign]);

  const isDirty = useMemo(
    () => JSON.stringify(design) !== lastSavedSnapshot,
    [design, lastSavedSnapshot],
  );

  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);

  // Imperative save helper used by autosave + ref consumers (manual save).
  // Only advances the saved-snapshot when the save reports success; on
  // failure the document stays dirty so the user can retry.
  const performSave = useCallback(async () => {
    if (!onSave) return false;
    const snapshot = JSON.stringify(design);
    try {
      const result = onSave(design);
      if (result && typeof result.then === 'function') {
        await result;
      }
      setLastSavedSnapshot(snapshot);
      return true;
    } catch (e) {
      return false;
    }
  }, [design, onSave]);

  // Autosave (debounced) — only fires when dirty and onSave provided.
  useEffect(() => {
    if (!onSave) return;
    if (!isDirty) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => { performSave(); }, 2000);
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [design, isDirty, onSave, performSave]);

  const setDesign = useCallback((updater) => {
    setDesignState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      if (next === prev) return prev;
      if (!skipHistoryRef.current) {
        undoStack.current = [...undoStack.current.slice(-(MAX_HISTORY - 1)), prev];
        redoStack.current = [];
        forceHistTick((n) => n + 1);
      }
      skipHistoryRef.current = false;
      return next;
    });
  }, []);

  const handleUndo = useCallback(() => {
    if (undoStack.current.length === 0) return;
    const prev = undoStack.current[undoStack.current.length - 1];
    undoStack.current = undoStack.current.slice(0, -1);
    setDesignState((current) => {
      redoStack.current = [...redoStack.current, current];
      return prev;
    });
    forceHistTick((n) => n + 1);
  }, []);

  const handleRedo = useCallback(() => {
    if (redoStack.current.length === 0) return;
    const next = redoStack.current[redoStack.current.length - 1];
    redoStack.current = redoStack.current.slice(0, -1);
    setDesignState((current) => {
      undoStack.current = [...undoStack.current, current];
      return next;
    });
    forceHistTick((n) => n + 1);
  }, []);

  const children = useMemo(() => getRootChildren(design), [design]);
  // Task #1425: layer groups registry for the current design.
  const groups = useMemo(() => getGroups(design), [design]);

  // Task #1609 — fit symbol instance boxes to their rendered content. The
  // editor draws a symbol's real children inside the instance box, but the
  // box itself keeps its placeholder/default size, so selection + resize/move
  // handles don't line up with what is drawn. We derive a display-only set of
  // children where each symbol block's width/height is replaced by the
  // measured content extent per breakpoint. This never touches `design` /
  // history — only what the stage renders. Symbols are authored with their
  // content top-left at the origin, so the box stays at the host x/y and just
  // grows/shrinks to wrap the content.
  const { symbolsById } = useCanvasSymbolsData();
  const displayChildren = useMemo(() => {
    if (!symbolsById || symbolsById.size === 0) return children;
    let changed = false;
    const out = children.map((b) => {
      if (b.type !== BLOCK_TYPES.SYMBOL) return b;
      const sym = symbolsById.get(b?.content?.symbolId);
      if (!sym || !sym.design) return b;
      const nextBp = { ...(b.bp || {}) };
      let blockChanged = false;
      for (const key of ['desktop', 'tablet', 'mobile']) {
        // Fit every breakpoint, even ones with no explicit override: symbol
        // content can resolve to a different extent at tablet/mobile. We only
        // ever set display-only w/h here (never x/y), so resolveBlockAtBreak-
        // point still cascades x/y from desktop for breakpoints that had no
        // explicit frame, and per-breakpoint x/y overrides are preserved.
        const ext = symbolContentExtent(sym.design, key);
        if (!ext) continue;
        nextBp[key] = { ...(nextBp[key] || {}), w: ext.w, h: ext.h };
        blockChanged = true;
      }
      if (!blockChanged) return b;
      changed = true;
      return { ...b, bp: nextBp };
    });
    return changed ? out : children;
  }, [children, symbolsById]);

  // Expand a set of selected ids so that whenever any member of a group is
  // present, all of that group's members are included. Groups therefore
  // select and move as one unit.
  const expandSelectionToGroups = useCallback((ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return ids;
    if (!groups.length) return ids;
    const set = new Set(ids);
    const gids = new Set();
    for (const id of ids) {
      const b = children.find((c) => c.id === id);
      if (b?.groupId) gids.add(b.groupId);
    }
    if (gids.size === 0) return ids;
    for (const b of children) {
      if (b.groupId && gids.has(b.groupId)) set.add(b.id);
    }
    return Array.from(set);
  }, [children, groups]);
  // Live bottom Y of in-progress drag/resize previews emitted by CanvasStage.
  // 0 when no interaction is active.
  const [livePreviewBottom, setLivePreviewBottom] = useState(0);
  const stageHeight = useMemo(() => {
    // Use the content-fitted children so the stage grows to fit a symbol's
    // rendered content rather than its (smaller/larger) placeholder box.
    const committed = stageHeightForBreakpoint(displayChildren, breakpoint);
    const live = livePreviewBottom > 0 ? livePreviewBottom + 80 : 0;
    return Math.max(STAGE_MIN_HEIGHT, committed, live);
  }, [displayChildren, breakpoint, livePreviewBottom]);

  // Live accessibility audit (recomputes on every design change).
  const heuristicA11yIssues = useMemo(() => auditCanvasDesign(design), [design]);
  const a11yIssues = useMemo(
    () => [...heuristicA11yIssues, ...(Array.isArray(extraIssues) ? extraIssues : [])],
    [heuristicA11yIssues, extraIssues],
  );
  const a11yIssuesByBlock = useMemo(() => buildIssuesByBlock(a11yIssues), [a11yIssues]);

  const replaceChildren = useCallback((updater) => {
    setDesign((prev) => {
      const current = getRootChildren(prev);
      const next = typeof updater === 'function' ? updater(current) : updater;
      return setRootChildren(prev, next);
    });
  }, [setDesign]);

  // Imperative API — declared after `children` and `replaceChildren` so
  // useImperativeHandle's dependency array does not reference Temporal
  // Dead Zone bindings during the first render.
  useImperativeHandle(ref, () => ({
    saveNow: () => performSave(),
    isDirty: () => JSON.stringify(design) !== lastSavedSnapshot,
    getDesign: () => design,
    getA11yIssues: () => auditCanvasDesign(design),
    // Phase 7 — programmatic block insertion used by templates / symbols /
    // command palette. Accepts an array of partial block objects which are
    // passed through createBlock so defaults & ids are populated. Returns
    // the ids that were actually inserted.
    addBlocks: (blocks) => {
      const arr = Array.isArray(blocks) ? blocks : [blocks];
      // Programmatic inserts (symbols, command palette, templates) have no
      // pointer to anchor to. Unless the caller passes an explicit position,
      // drop the block centered on whatever the user is currently looking at
      // (mirrors the pointer-anchored placement used for palette drag/drop),
      // so it doesn't land at the far top-left off-screen.
      const center = computeViewportCenter();
      const created = arr.map((b) => {
        const type = b.type || BLOCK_TYPES.BOX;
        const hasExplicitPos =
          b.desktop && (b.desktop.x != null || b.desktop.y != null);
        let overrides = b;
        if (center && !hasExplicitPos) {
          const defaults = getBlockDefaults(type);
          const blockW = b.desktop?.w ?? defaults.geom?.w ?? 200;
          const blockH = b.desktop?.h ?? defaults.geom?.h ?? 120;
          const x = Math.max(
            0,
            Math.round((center.x - blockW / 2) / gridSize) * gridSize,
          );
          const y = Math.max(
            0,
            Math.round((center.y - blockH / 2) / gridSize) * gridSize,
          );
          overrides = { ...b, desktop: { ...(b.desktop || {}), x, y } };
        }
        return createBlock(type, overrides);
      });
      replaceChildren((existing) => [...existing, ...created]);
      const newIds = created.map((c) => c.id);
      setSelectedIds(newIds);
      // Scroll the first inserted block into view and select it (inspector
      // opens), matching setSelection's behavior for programmatic navigation.
      if (newIds[0] && typeof document !== 'undefined') {
        setTimeout(() => {
          const stage = document.querySelector('[data-testid="canvas-stage"]');
          const el = (stage || document).querySelector(
            `[data-testid="canvas-block-${newIds[0]}"]`,
          );
          if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 50);
      }
      return newIds;
    },
    getSelectedIds: () => selectedIds,
    getSelectedBlocks: () => children.filter((b) => selectedIds.includes(b.id)),
    setDesign: (next) => setDesignState(normalizeCanvasDesign(next)),
    // Phase 7 — used by the command palette to jump to a block. Scrolls
    // the block into view inside the editor stage and selects it so the
    // inspector opens automatically.
    setSelection: (ids) => {
      const arr = Array.isArray(ids) ? ids : [ids];
      setSelectedIds(arr);
      if (arr[0] && typeof document !== 'undefined') {
        setTimeout(() => {
          // Scope to the canvas stage — `data-block-id` also appears on
          // a11y panel rows, so a document-wide query can resolve to the
          // wrong element.
          const stage = document.querySelector('[data-testid="canvas-stage"]');
          const el = (stage || document).querySelector(
            `[data-testid="canvas-block-${arr[0]}"]`,
          );
          if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 50);
      }
    },
  }), [performSave, design, lastSavedSnapshot, replaceChildren, selectedIds, children, zoom, gridSize]);

  const updateBlock = useCallback((id, updater) => {
    replaceChildren((arr) =>
      arr.map((b) => (b.id === id ? (typeof updater === 'function' ? updater(b) : updater) : b)),
    );
  }, [replaceChildren]);

  // ---- Selection helpers ----
  const selectedBlocks = useMemo(
    () => children.filter((b) => selectedIds.includes(b.id)),
    [children, selectedIds],
  );

  const handleSelect = useCallback((idsOrId, additive = false) => {
    if (Array.isArray(idsOrId)) {
      setSelectedIds(expandSelectionToGroups(idsOrId));
      return;
    }
    if (additive) {
      // Shift-toggling a grouped block toggles the whole group at once.
      const members = expandSelectionToGroups([idsOrId]);
      setSelectedIds((prev) => {
        const allPresent = members.every((m) => prev.includes(m));
        return allPresent
          ? prev.filter((x) => !members.includes(x))
          : Array.from(new Set([...prev, ...members]));
      });
    } else {
      setSelectedIds(expandSelectionToGroups([idsOrId]));
    }
  }, [expandSelectionToGroups]);

  const handleMarqueeSelect = useCallback((ids, additive) => {
    if (additive) {
      setSelectedIds((prev) => expandSelectionToGroups(Array.from(new Set([...prev, ...ids]))));
    } else {
      setSelectedIds(expandSelectionToGroups(ids));
    }
  }, [expandSelectionToGroups]);

  // ---- Geometry commit (after drag/resize) ----
  const applyGeometry = useCallback((updates) => {
    replaceChildren((arr) => arr.map((b) => {
      const u = updates[b.id];
      if (!u) return b;
      // Symbol boxes derive their width/height from content at read time
      // (Task #1609), so a move/resize only ever stores the host position —
      // never a distinct size, keeping the saved design free of fitted
      // geometry.
      if (b.type === BLOCK_TYPES.SYMBOL) {
        return setBlockBp(b, breakpoint, { x: Math.round(u.x), y: Math.round(u.y) });
      }
      // Round to integers for clean serialization. Full-width blocks
      // ignore horizontal geometry (x/w are derived from the canvas).
      const patch = b.fullWidth
        ? { y: Math.round(u.y), h: Math.round(u.h) }
        : {
            x: Math.round(u.x), y: Math.round(u.y),
            w: Math.round(u.w), h: Math.round(u.h),
          };
      // Vertical card resize flags an explicit author height for the active
      // breakpoint (stored alongside the geometry so it inherits + round-trips
      // like any other per-breakpoint override). The reflow context reads it as
      // a lower bound; it has no CSS effect (buildCanvasCss ignores it).
      if (u.manualHeight) patch.manualHeight = true;
      return setBlockBp(b, breakpoint, patch);
    }));
  }, [replaceChildren, breakpoint]);

  // ---- Auto-height commit (Text, FAQ/Accordion) ----
  // Auto-height blocks render at their content height (height:auto) but their
  // stored geom.h never tracks that, so stageHeightForBreakpoint (and thus the
  // published CSS stage height) can't grow to fit them. The runtime reflow
  // (AccordionReflowContext) only paints over this at read time: it pushes
  // blocks below down by (measured - stored h) and grows containing sections /
  // the stage minHeight. Nothing is persisted, so the published SSR/CSS render
  // is wrong until JS runs.
  //
  // When an auto-height block reports its measured height we BAKE the reflow
  // into stored geometry for the breakpoint currently being edited, mirroring
  // AccordionReflowContext exactly so there is zero visual change:
  //   1. set the block's own h to the measured height,
  //   2. push every block entirely below it down by the delta (getOffset), and
  //   3. grow every Section that contains it by the delta (getSectionGrowth).
  // Because stored geometry then matches what was rendered, the runtime reflow
  // collapses to a no-op for the authored/collapsed state, while genuine
  // runtime expansion (a visitor opening an accordion) still reflows as before.
  //
  // Debounced per block and flagged skip-history so it never spams the undo
  // stack; a 2px dead-band keeps the ResizeObserver from churning autosave with
  // sub-pixel micro-changes. Committing h/y never changes any block's rendered
  // height (auto-height blocks stay height:auto; pushes only move `top`), so
  // there is no measure -> commit -> re-measure loop.
  const autoHeightTimers = useRef(new Map());
  const commitAutoHeight = useCallback((blockId, measuredHeight) => {
    if (!blockId || !Number.isFinite(measuredHeight)) return;
    const rounded = Math.round(measuredHeight);
    if (rounded <= 0) return;
    const timers = autoHeightTimers.current;
    if (timers.has(blockId)) clearTimeout(timers.get(blockId));
    timers.set(blockId, setTimeout(() => {
      timers.delete(blockId);
      skipHistoryRef.current = true;
      setDesign((prev) => {
        const abort = () => { skipHistoryRef.current = false; return prev; };
        const kids = getRootChildren(prev);
        const target = kids.find((x) => x.id === blockId);
        if (!target) return abort();
        const def = getBlockDefinition(target.type);
        // Bake heights only for plain auto-height blocks (Text, FAQ/Accordion).
        // Card blocks are autoHeight + cardGrow: their stored/manual box height
        // is the author's intended size and they rely on runtime row-height
        // equalization (getRowHeight), so baking their measured content height
        // into stored geom would fight that system and drift manual resizes.
        if (!def?.autoHeight || def?.cardGrow) return abort();
        const tg = resolveBlockAtBreakpoint(target, breakpoint);
        if (!tg || tg.hidden) return abort();
        const delta = rounded - (tg.h || 0);
        // Dead-band: ignore tiny deltas so we don't fight the ResizeObserver
        // or churn autosave with micro-changes.
        if (Math.abs(delta) < 2) return abort();
        const targetTop = tg.y;
        const targetBottom = tg.y + (tg.h || 0);
        const nextKids = kids.map((x) => {
          if (x.id === blockId) return setBlockBp(x, breakpoint, { h: rounded });
          const g = resolveBlockAtBreakpoint(x, breakpoint);
          if (!g || g.hidden) return x;
          const gBottom = g.y + (g.h || 0);
          // (2) Block entirely below the target -> shift down by delta.
          if (targetBottom <= g.y) {
            return setBlockBp(x, breakpoint, { y: Math.round(g.y + delta) });
          }
          // (3) Section that contains the target -> grow by delta.
          if (
            x.type === BLOCK_TYPES.SECTION &&
            targetTop >= g.y &&
            targetBottom <= gBottom
          ) {
            return setBlockBp(x, breakpoint, { h: Math.round((g.h || 0) + delta) });
          }
          return x;
        });
        return setRootChildren(prev, nextKids);
      });
    }, 200));
  }, [breakpoint, setDesign]);

  // Cancel any pending auto-height commits on unmount.
  useEffect(() => () => {
    for (const t of autoHeightTimers.current.values()) clearTimeout(t);
    autoHeightTimers.current.clear();
  }, []);

  // ---- Auto build tablet + mobile layouts (Task #2434) ----
  // Generates both breakpoint layouts from the desktop layout in a single
  // setDesign call, so the whole operation is one undo step. Desktop
  // geometry is never touched. Afterwards the editor switches to the
  // mobile breakpoint so the result is immediately visible (and the
  // auto-height commit path refines estimated text/accordion heights
  // against the real render).
  const [showAutoBuildConfirm, setShowAutoBuildConfirm] = useState(false);
  const runAutoBuild = useCallback(() => {
    // Resolve symbol content extents so symbol hosts can be kept on the
    // stage (a symbol box's stored w/h are placeholders — the rendered
    // size comes from the symbol's own design per breakpoint).
    const getSymbolExtent = (symbolId, bp) => {
      const sym = symbolsById?.get(symbolId);
      return sym?.design ? symbolContentExtent(sym.design, bp) : null;
    };
    setDesign((prev) => generateAutoLayout(prev, { getBlockDefinition, getSymbolExtent }));
    onBreakpointChange?.('mobile');
  }, [setDesign, onBreakpointChange, symbolsById]);
  const handleAutoBuildClick = useCallback(() => {
    if (hasResponsiveGeometryOverrides(design)) {
      setShowAutoBuildConfirm(true);
    } else {
      runAutoBuild();
    }
  }, [design, runAutoBuild]);

  // ---- DnD palette -> canvas ----
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const stageWrapperRef = useRef(null);

  // Live pointer position during a palette drag. dnd-kit's `delta` (and the
  // translated active rect derived from it) gets distorted by auto-scroll
  // when dragging near the stage edges, which is what throws a dropped block
  // far down the page. We instead read the real pointer from native events
  // and use that as the source of truth for the drop point.
  const lastPointerRef = useRef(null);
  // Edge auto-scroll for palette drags. We drive it ourselves (and disable
  // dnd-kit's built-in autoScroll on the DndContext) so the palette path uses
  // the exact same threshold/ramp/speed as the on-canvas block drag.
  const paletteAutoScroll = useEdgeAutoScroll(stageWrapperRef);
  const trackPointer = useCallback((e) => {
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
    paletteAutoScroll.update(e.clientX, e.clientY);
  }, [paletteAutoScroll]);

  const handleDragStart = (event) => {
    setActiveDragId(event.active.id);
    setActiveDragType(event.active.data?.current?.type || null);
    // Seed with the activator position, then follow the live pointer for the
    // rest of the drag. Capture phase so we still see the move even if
    // dnd-kit handles the event first.
    lastPointerRef.current = event.activatorEvent
      ? { x: event.activatorEvent.clientX || 0, y: event.activatorEvent.clientY || 0 }
      : null;
    window.addEventListener('pointermove', trackPointer, true);
  };

  const handleDragCancel = () => {
    window.removeEventListener('pointermove', trackPointer, true);
    paletteAutoScroll.stop();
    setActiveDragId(null);
    setActiveDragType(null);
    lastPointerRef.current = null;
  };

  const handleDragEnd = (event) => {
    window.removeEventListener('pointermove', trackPointer, true);
    paletteAutoScroll.stop();
    setActiveDragId(null);
    setActiveDragType(null);
    const { active, over } = event;
    const pointer = lastPointerRef.current;
    lastPointerRef.current = null;
    if (!over) return;
    const fromPalette = active.data?.current?.fromPalette;
    if (!fromPalette) return;
    if (over.id !== 'canvas-drop-zone') return;

    const newType = active.data?.current?.type || BLOCK_TYPES.BOX;
    const defaults = getBlockDefaults(newType);
    const blockW = defaults.geom?.w ?? 200;
    const blockH = defaults.geom?.h ?? 120;

    // Convert the live pointer to stage-local coordinates using the same
    // client->stage math the stage uses for moves (getStageCoords in
    // CanvasStage.jsx): subtract the stage's bounding rect and divide by
    // zoom. Anchor the block under the cursor, offset by (at most) half its
    // default size so the top-left lands roughly under the pointer without a
    // large jump for tall/wide blocks.
    let x = 40, y = 40;
    const stage = document.querySelector('[data-testid="canvas-stage"]');
    if (stage && pointer) {
      const rect = stage.getBoundingClientRect();
      const zoomFactor = zoom || 1;
      const offsetX = Math.min(blockW / 2, 40);
      const offsetY = Math.min(blockH / 2, 40);
      const localX = (pointer.x - rect.left) / zoomFactor - offsetX;
      const localY = (pointer.y - rect.top) / zoomFactor - offsetY;
      x = Math.max(0, Math.round(localX / gridSize) * gridSize);
      y = Math.max(0, Math.round(localY / gridSize) * gridSize);
    }

    const newBlock = createBlock(newType, {
      desktop: { x, y, hidden: false },
    });
    // Intelligent heading-level default: avoid duplicate H1s and keep
    // sibling Text/Hero/Card blocks from skipping levels.
    const suggested = suggestHeadingLevel(design, newType);
    const headingField = headingFieldFor(newType);
    if (suggested != null && headingField) {
      newBlock.content = {
        ...newBlock.content,
        [headingField]: headingField === 'headingAs' ? String(suggested) : suggested,
      };
    }
    replaceChildren((arr) => [...arr, newBlock]);
    setSelectedIds([newBlock.id]);
  };

  // Compute the center of the user's currently-visible stage area in
  // stage-local coordinates. Uses the same client->stage math as handleDragEnd
  // (subtract the stage's bounding rect, divide by zoom); because the stage
  // rect shifts as the scroll container scrolls, this naturally accounts for
  // the current scroll offset and zoom. Returns grid-snapped, non-negative
  // coordinates, or null if the stage isn't mounted yet.
  function computeViewportCenter() {
    const wrap = stageWrapperRef.current;
    const stage = document.querySelector('[data-testid="canvas-stage"]');
    if (!wrap || !stage) return null;
    const wrapRect = wrap.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const zoomFactor = zoom || 1;
    const centerClientX = wrapRect.left + wrap.clientWidth / 2;
    const centerClientY = wrapRect.top + wrap.clientHeight / 2;
    const localX = (centerClientX - stageRect.left) / zoomFactor;
    const localY = (centerClientY - stageRect.top) / zoomFactor;
    return {
      x: Math.max(0, Math.round(localX / gridSize) * gridSize),
      y: Math.max(0, Math.round(localY / gridSize) * gridSize),
    };
  }

  // Move a block up or down in the children array (= DOM/reading order).
  const moveBlockInReadingOrder = useCallback((id, direction) => {
    replaceChildren((arr) => {
      const idx = arr.findIndex((b) => b.id === id);
      if (idx < 0) return arr;
      const target = direction === 'up' ? idx - 1 : idx + 1;
      if (target < 0 || target >= arr.length) return arr;
      const next = arr.slice();
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return next;
    });
  }, [replaceChildren]);

  // ---- Layer reorder ----
  const handleReorderLayers = useCallback((newChildren) => {
    replaceChildren(() => newChildren);
  }, [replaceChildren]);

  // ---- Block actions ----
  const deleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    replaceChildren((arr) => arr.filter((b) => !selectedIds.includes(b.id) || b.locked));
    setSelectedIds([]);
  }, [selectedIds, replaceChildren]);

  const duplicateSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    const newIds = [];
    replaceChildren((arr) => {
      const toDup = arr.filter((b) => selectedIds.includes(b.id));
      const copies = toDup.map((b) => {
        const copy = createBlock(b.type, {
          desktop: { ...resolveBlockAtBreakpoint(b, 'desktop'),
            x: (b.bp.desktop.x || 0) + 16, y: (b.bp.desktop.y || 0) + 16 },
          tablet: { ...b.bp.tablet },
          mobile: { ...b.bp.mobile },
          style: { ...b.style },
          a11y: { ...b.a11y },
          content: JSON.parse(JSON.stringify(b.content || {})),
          name: `${b.name} copy`,
        });
        newIds.push(copy.id);
        return copy;
      });
      return [...arr, ...copies];
    });
    setSelectedIds(newIds);
  }, [selectedIds, replaceChildren]);

  const duplicateById = useCallback((id) => {
    const b = children.find((c) => c.id === id);
    if (!b) return;
    const copy = createBlock(b.type, {
      desktop: { ...resolveBlockAtBreakpoint(b, 'desktop'),
        x: (b.bp.desktop.x || 0) + 16, y: (b.bp.desktop.y || 0) + 16 },
      tablet: { ...b.bp.tablet },
      mobile: { ...b.bp.mobile },
      style: { ...b.style },
      a11y: { ...b.a11y },
      content: JSON.parse(JSON.stringify(b.content || {})),
      name: `${b.name} copy`,
    });
    replaceChildren((arr) => [...arr, copy]);
    setSelectedIds([copy.id]);
  }, [children, replaceChildren]);

  const deleteById = useCallback((id) => {
    replaceChildren((arr) => arr.filter((b) => b.id !== id));
    setSelectedIds((prev) => prev.filter((x) => x !== id));
  }, [replaceChildren]);

  const toggleHiddenById = useCallback((id) => {
    updateBlock(id, (b) => {
      const current = resolveBlockAtBreakpoint(b, breakpoint).hidden;
      return setBlockBp(b, breakpoint, { hidden: !current });
    });
  }, [updateBlock, breakpoint]);

  const toggleLockedById = useCallback((id) => {
    updateBlock(id, (b) => ({ ...b, locked: !b.locked }));
  }, [updateBlock]);

  const renameById = useCallback((id, name) => {
    updateBlock(id, (b) => ({ ...b, name }));
  }, [updateBlock]);

  const clearOverrideById = useCallback((id, bp, field) => {
    updateBlock(id, (b) => clearBpOverride(b, bp, field));
  }, [updateBlock]);

  // ---- Group actions (Task #1425) ----
  // Distinct group ids represented in the current selection.
  const selectedGroupIds = useMemo(() => {
    const set = new Set();
    for (const id of selectedIds) {
      const b = children.find((c) => c.id === id);
      if (b?.groupId) set.add(b.groupId);
    }
    return Array.from(set);
  }, [selectedIds, children]);

  // Can group when 2+ blocks are selected and they are not already exactly
  // one existing group (re-grouping the same set is a no-op we hide).
  const canGroupSelection = useMemo(() => {
    if (selectedIds.length < 2) return false;
    if (selectedGroupIds.length === 1) {
      const members = children.filter((b) => b.groupId === selectedGroupIds[0]);
      const allSelected = members.every((m) => selectedIds.includes(m.id));
      if (allSelected && members.length === selectedIds.length) return false;
    }
    return true;
  }, [selectedIds, selectedGroupIds, children]);

  const canUngroupSelection = selectedGroupIds.length > 0;

  const groupSelected = useCallback(() => {
    if (selectedIds.length < 2) return;
    const ids = selectedIds.slice();
    setDesign((prev) => {
      const res = createGroup(prev, ids);
      return res ? res.design : prev;
    });
    setSelectedIds(ids);
  }, [selectedIds, setDesign]);

  const ungroupSelected = useCallback(() => {
    if (selectedGroupIds.length === 0) return;
    const gids = selectedGroupIds.slice();
    setDesign((prev) => {
      let d = prev;
      for (const gid of gids) d = ungroup(d, gid);
      return d;
    });
  }, [selectedGroupIds, setDesign]);

  const ungroupById = useCallback((gid) => {
    if (!gid) return;
    setDesign((prev) => ungroup(prev, gid));
  }, [setDesign]);

  // Select every member of a group (used by the layers palette group row).
  const selectGroup = useCallback((gid, additive = false) => {
    const memberIds = children.filter((b) => b.groupId === gid).map((b) => b.id);
    if (memberIds.length === 0) return;
    if (additive) {
      setSelectedIds((prev) => {
        const allPresent = memberIds.every((m) => prev.includes(m));
        return allPresent
          ? prev.filter((x) => !memberIds.includes(x))
          : Array.from(new Set([...prev, ...memberIds]));
      });
    } else {
      setSelectedIds(memberIds);
    }
  }, [children]);

  const renameGroup = useCallback((gid, name) => {
    setDesign((prev) => setGroups(prev, getGroups(prev).map((g) =>
      g.id === gid ? { ...g, name: name && name.trim() ? name : g.name } : g)));
  }, [setDesign]);

  // Collapse/expand is a view-only flag: persisted with the design but does
  // not push an undo step (it would be noise in the history).
  const toggleGroupCollapsed = useCallback((gid) => {
    skipHistoryRef.current = true;
    setDesign((prev) => setGroups(prev, getGroups(prev).map((g) =>
      g.id === gid ? { ...g, collapsed: !g.collapsed } : g)));
  }, [setDesign]);

  // Group visibility toggle: hides/shows all members at the current
  // breakpoint. The group is considered hidden only when every member is
  // hidden, so the toggle flips to the inverse for the whole set.
  const toggleGroupHidden = useCallback((gid) => {
    const members = children.filter((b) => b.groupId === gid);
    if (members.length === 0) return;
    const allHidden = members.every((b) => resolveBlockAtBreakpoint(b, breakpoint).hidden);
    replaceChildren((arr) => arr.map((b) =>
      b.groupId === gid ? setBlockBp(b, breakpoint, { hidden: !allHidden }) : b));
  }, [children, breakpoint, replaceChildren]);

  // Group lock toggle: locks/unlocks all members. Locked only when every
  // member is locked.
  const toggleGroupLocked = useCallback((gid) => {
    const members = children.filter((b) => b.groupId === gid);
    if (members.length === 0) return;
    const allLocked = members.every((b) => b.locked);
    replaceChildren((arr) => arr.map((b) =>
      b.groupId === gid ? { ...b, locked: !allLocked } : b));
  }, [children, replaceChildren]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore when typing in inputs
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      // A guide drag owns the keyboard (Delete removes/cancels the guide) —
      // don't also fall through to block deletion/nudging.
      if (guideDragRef.current) return;

      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault(); handleUndo(); return;
      }
      if ((meta && e.key.toLowerCase() === 'y') ||
          (meta && e.shiftKey && e.key.toLowerCase() === 'z')) {
        e.preventDefault(); handleRedo(); return;
      }
      if (meta && e.key.toLowerCase() === 'd') {
        e.preventDefault(); duplicateSelected(); return;
      }
      // Group / Ungroup (Task #1425): Ctrl/Cmd+G groups the selection,
      // Ctrl/Cmd+Shift+G ungroups any group in the selection.
      if (meta && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        if (e.shiftKey) ungroupSelected();
        else groupSelected();
        return;
      }
      // Copy / cut / paste — clipboard lives on window so users can paste
      // between pages within the same browser session.
      if (meta && e.key.toLowerCase() === 'c' && selectedIds.length > 0) {
        e.preventDefault();
        const copies = children
          .filter((b) => selectedIds.includes(b.id))
          .map((b) => JSON.parse(JSON.stringify(b)));
        window.__canvasClipboard = copies;
        return;
      }
      if (meta && e.key.toLowerCase() === 'x' && selectedIds.length > 0) {
        e.preventDefault();
        const copies = children
          .filter((b) => selectedIds.includes(b.id))
          .map((b) => JSON.parse(JSON.stringify(b)));
        window.__canvasClipboard = copies;
        deleteSelected();
        return;
      }
      if (meta && e.key.toLowerCase() === 'v') {
        const clip = window.__canvasClipboard;
        if (Array.isArray(clip) && clip.length > 0) {
          e.preventDefault();
          const newIds = [];
          replaceChildren((arr) => {
            const copies = clip.map((b) => {
              const copy = createBlock(b.type, {
                desktop: {
                  ...(b.bp?.desktop || {}),
                  x: (b.bp?.desktop?.x || 0) + 24,
                  y: (b.bp?.desktop?.y || 0) + 24,
                },
                tablet: { ...(b.bp?.tablet || {}) },
                mobile: { ...(b.bp?.mobile || {}) },
                style: { ...(b.style || {}) },
                a11y: { ...(b.a11y || {}) },
                content: JSON.parse(JSON.stringify(b.content || {})),
                name: b.name,
              });
              newIds.push(copy.id);
              return copy;
            });
            return [...arr, ...copies];
          });
          setSelectedIds(newIds);
          return;
        }
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIds.length > 0) {
          e.preventDefault(); deleteSelected(); return;
        }
      }
      if (selectedIds.length > 0 && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? gridSize : 1;
        let dx = 0, dy = 0;
        if (e.key === 'ArrowUp') dy = -step;
        if (e.key === 'ArrowDown') dy = step;
        if (e.key === 'ArrowLeft') dx = -step;
        if (e.key === 'ArrowRight') dx = step;
        const updates = {};
        for (const id of selectedIds) {
          const b = children.find((c) => c.id === id);
          if (!b || b.locked) continue;
          const geom = resolveBlockAtBreakpoint(b, breakpoint);
          updates[id] = { x: geom.x + dx, y: geom.y + dy, w: geom.w, h: geom.h };
        }
        if (Object.keys(updates).length > 0) applyGeometry(updates);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo, duplicateSelected, deleteSelected, groupSelected, ungroupSelected, selectedIds, children, breakpoint, applyGeometry, gridSize]);

  // ---- Align / distribute ----
  // With 2+ blocks selected the most-recently-selected id (last in
  // `selectedIds`) is treated as the **anchor** — other selected blocks
  // align to its edges/center (Figma/Sketch "select anchor last" pattern).
  // Users can override the reference frame via the toolbar selector
  // (Anchor / Selection / Canvas). When in 'anchor' mode, a manual
  // override wins when the user has explicitly picked an anchor from
  // the dropdown and that block is still selected. Otherwise we fall
  // back to the implicit "last selected = anchor" rule.
  const anchorId = selectedIds.length >= 2
    ? (manualAnchorId && selectedIds.includes(manualAnchorId)
        ? manualAnchorId
        : selectedIds[selectedIds.length - 1])
    : null;
  const anchorBlock = useMemo(
    () => (anchorId ? children.find((b) => b.id === anchorId) : null),
    [anchorId, children],
  );

  // Effective reference frame for the current selection: 'anchor' needs at
  // least two alignment units to anchor against (a group counts as one unit),
  // so it collapses to 'canvas' when there are fewer than two units. This is
  // why selecting a single group and aligning moves it relative to the canvas.
  const effectiveAlignRef = useMemo(() => {
    if (alignRef !== 'anchor') return alignRef;
    const keys = new Set();
    for (const id of selectedIds) {
      const b = children.find((c) => c.id === id);
      if (!b) continue;
      keys.add(b.groupId ? `group:${b.groupId}` : `block:${id}`);
    }
    return keys.size < 2 ? 'canvas' : 'anchor';
  }, [alignRef, selectedIds, children]);

  const alignSelected = useCallback((mode) => {
    if (selectedIds.length < 1) return;
    const blocksGeom = selectedIds
      .map((id) => {
        const b = children.find((c) => c.id === id);
        if (!b) return null;
        return { id, geom: resolveBlockAtBreakpoint(b, breakpoint), groupId: b.groupId || null };
      })
      .filter(Boolean);
    if (blocksGeom.length < 1) return;

    // Partition the selection into alignment units: blocks sharing a groupId
    // form a single unit (aligned by their combined bounding box); ungrouped
    // blocks are each their own unit. This keeps a group's internal layout
    // intact when it is aligned as a whole.
    const unitMap = new Map();
    for (const item of blocksGeom) {
      const key = item.groupId ? `group:${item.groupId}` : `block:${item.id}`;
      if (!unitMap.has(key)) unitMap.set(key, { key, members: [] });
      unitMap.get(key).members.push(item);
    }
    const bboxOf = (members) => {
      const x = Math.min(...members.map((m) => m.geom.x));
      const right = Math.max(...members.map((m) => m.geom.x + m.geom.w));
      const y = Math.min(...members.map((m) => m.geom.y));
      const bottom = Math.max(...members.map((m) => m.geom.y + m.geom.h));
      return { x, right, y, bottom, w: right - x, h: bottom - y };
    };

    // Determine the alignment reference frame.
    let minX, maxRight, minY, maxBottom;
    let activeAnchorKey = null;
    if (effectiveAlignRef === 'canvas') {
      const cW = BREAKPOINT_WIDTHS[breakpoint] || BREAKPOINT_WIDTHS.desktop;
      const cH = STAGE_MIN_HEIGHT;
      minX = 0;
      maxRight = cW;
      minY = 0;
      maxBottom = cH;
    } else if (effectiveAlignRef === 'selection') {
      minX = Math.min(...blocksGeom.map((b) => b.geom.x));
      maxRight = Math.max(...blocksGeom.map((b) => b.geom.x + b.geom.w));
      minY = Math.min(...blocksGeom.map((b) => b.geom.y));
      maxBottom = Math.max(...blocksGeom.map((b) => b.geom.y + b.geom.h));
    } else {
      // 'anchor' — the unit that owns the anchor block. The anchor's whole
      // unit (a group, if it belongs to one) forms the reference frame, so a
      // group is anchored as a single unit. effectiveAlignRef collapses to
      // 'canvas' when there are fewer than two units, so this unit exists.
      const anchorItem = blocksGeom.find((b) => b.id === anchorId) || blocksGeom[blocksGeom.length - 1];
      activeAnchorKey = anchorItem.groupId ? `group:${anchorItem.groupId}` : `block:${anchorItem.id}`;
      const bb = bboxOf(unitMap.get(activeAnchorKey).members);
      minX = bb.x;
      maxRight = bb.right;
      minY = bb.y;
      maxBottom = bb.bottom;
    }
    const centerX = (minX + maxRight) / 2;
    const centerY = (minY + maxBottom) / 2;

    const updates = {};
    for (const unit of unitMap.values()) {
      // Never move the unit that contains the anchor when aligning to it.
      if (activeAnchorKey && unit.key === activeAnchorKey) continue;
      const bb = bboxOf(unit.members);
      // Uniform delta to align the unit's bounding box to the reference frame.
      let dx = 0, dy = 0;
      if (mode === 'left') dx = minX - bb.x;
      if (mode === 'right') dx = (maxRight - bb.w) - bb.x;
      if (mode === 'hcenter') dx = Math.round(centerX - bb.w / 2) - bb.x;
      if (mode === 'top') dy = minY - bb.y;
      if (mode === 'bottom') dy = (maxBottom - bb.h) - bb.y;
      if (mode === 'vcenter') dy = Math.round(centerY - bb.h / 2) - bb.y;
      if (dx === 0 && dy === 0) continue;
      // Apply the same delta to every member, preserving relative positions.
      for (const m of unit.members) {
        updates[m.id] = { x: m.geom.x + dx, y: m.geom.y + dy, w: m.geom.w, h: m.geom.h };
      }
    }
    if (Object.keys(updates).length > 0) applyGeometry(updates);
  }, [selectedIds, anchorId, children, breakpoint, applyGeometry, effectiveAlignRef]);

  const distributeSelected = useCallback((axis) => {
    if (selectedIds.length < 3) return;
    const blocksGeom = selectedIds
      .map((id) => {
        const b = children.find((c) => c.id === id);
        if (!b) return null;
        return { id, geom: resolveBlockAtBreakpoint(b, breakpoint), groupId: b.groupId || null };
      })
      .filter(Boolean);

    // Partition into units: grouped blocks distribute as one unit (by their
    // combined bounding box); ungrouped blocks are each their own unit.
    const unitMap = new Map();
    for (const item of blocksGeom) {
      const k = item.groupId ? `group:${item.groupId}` : `block:${item.id}`;
      if (!unitMap.has(k)) unitMap.set(k, []);
      unitMap.get(k).push(item);
    }
    const units = Array.from(unitMap.values()).map((members) => {
      const x = Math.min(...members.map((m) => m.geom.x));
      const y = Math.min(...members.map((m) => m.geom.y));
      const w = Math.max(...members.map((m) => m.geom.x + m.geom.w)) - x;
      const h = Math.max(...members.map((m) => m.geom.y + m.geom.h)) - y;
      return { members, x, y, w, h };
    });
    if (units.length < 3) return;

    const key = axis === 'h' ? 'x' : 'y';
    const sizeKey = axis === 'h' ? 'w' : 'h';
    units.sort((a, b) => (a[key] + a[sizeKey] / 2) - (b[key] + b[sizeKey] / 2));
    const first = units[0];
    const last = units[units.length - 1];
    const firstCenter = first[key] + first[sizeKey] / 2;
    const lastCenter = last[key] + last[sizeKey] / 2;
    const step = (lastCenter - firstCenter) / (units.length - 1);
    const updates = {};
    units.forEach((unit, idx) => {
      if (idx === 0 || idx === units.length - 1) return;
      const targetCenter = firstCenter + step * idx;
      const target = Math.round(targetCenter - unit[sizeKey] / 2);
      const delta = target - unit[key];
      if (delta === 0) return;
      // Apply the same delta to every member, preserving relative positions.
      for (const m of unit.members) {
        updates[m.id] = {
          ...m.geom,
          [key]: m.geom[key] + delta,
        };
      }
    });
    if (Object.keys(updates).length > 0) applyGeometry(updates);
  }, [selectedIds, children, breakpoint, applyGeometry]);

  const canvasWidth = BREAKPOINT_WIDTHS[breakpoint] || BREAKPOINT_WIDTHS.desktop;

  // ---- Ruler guides (Task #1665) ----
  const guides = useMemo(() => getCanvasGuides(design), [design]);
  const hasGuides = guides.vertical.length + guides.horizontal.length > 0;
  // Plain positions (no lock state) for the stage's snap targets — locked
  // guides still snap, so all guides are included.
  const guidePositions = useMemo(() => getCanvasGuidePositions(design), [design]);

  // Convert a client (screen) point into stage coordinates using the guide
  // overlay wrapper, whose top-left == stage origin.
  const clientToStage = useCallback((clientX, clientY) => {
    const el = guideAreaRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const z = zoom || 1;
    return { x: (clientX - rect.left) / z, y: (clientY - rect.top) / z };
  }, [zoom]);

  // Given a pointer position, compute the snapped guide value and whether the
  // drag is currently in "remove" territory (pointer pulled back onto/past the
  // originating ruler, i.e. negative coordinate).
  const computeGuideValue = useCallback((orientation, clientX, clientY) => {
    const { x, y } = clientToStage(clientX, clientY);
    const raw = orientation === 'vertical' ? x : y;
    const max = orientation === 'vertical' ? canvasWidth : stageHeight;
    const clamped = Math.max(0, Math.min(raw, max));
    return { value: snapGuideValue(clamped, gridSize), removing: raw < 0 };
  }, [clientToStage, canvasWidth, stageHeight, gridSize]);

  const commitGuide = useCallback((descriptor, value, removing) => {
    const { kind, orientation, index } = descriptor;
    setDesign((prev) => {
      const g = getCanvasGuides(prev);
      const vertical = [...g.vertical];
      const horizontal = [...g.horizontal];
      const arr = orientation === 'vertical' ? vertical : horizontal;
      if (kind === 'create') {
        if (removing) return prev; // dropped back on the ruler — no-op
        arr.push({ pos: value, locked: false });
      } else { // move
        if (removing) arr.splice(index, 1);
        else if (arr[index]) arr[index] = { ...arr[index], pos: value };
      }
      return setCanvasGuides(prev, { vertical, horizontal });
    });
  }, [setDesign]);

  const removeGuideAt = useCallback((orientation, index) => {
    setDesign((prev) => {
      const g = getCanvasGuides(prev);
      const vertical = [...g.vertical];
      const horizontal = [...g.horizontal];
      const arr = orientation === 'vertical' ? vertical : horizontal;
      arr.splice(index, 1);
      return setCanvasGuides(prev, { vertical, horizontal });
    });
  }, [setDesign]);

  const clearGuides = useCallback(() => {
    setDesign((prev) => setCanvasGuides(prev, { vertical: [], horizontal: [] }));
  }, [setDesign]);

  // Task #1667: toggle a guide's locked flag. Locked guides ignore drag/Delete
  // (enforced in startGuideMove + the overlay) but still act as snap targets.
  const toggleGuideLock = useCallback((orientation, index) => {
    setDesign((prev) => {
      const g = getCanvasGuides(prev);
      const vertical = [...g.vertical];
      const horizontal = [...g.horizontal];
      const arr = orientation === 'vertical' ? vertical : horizontal;
      if (!arr[index]) return prev;
      arr[index] = { ...arr[index], locked: !arr[index].locked };
      return setCanvasGuides(prev, { vertical, horizontal });
    });
  }, [setDesign]);

  // Task #1667: set an exact numeric position for a guide (typed in the
  // overlay). Clamped to the stage bounds; locked guides are left untouched.
  const setGuidePosition = useCallback((orientation, index, pos) => {
    setDesign((prev) => {
      const g = getCanvasGuides(prev);
      const vertical = [...g.vertical];
      const horizontal = [...g.horizontal];
      const arr = orientation === 'vertical' ? vertical : horizontal;
      if (!arr[index] || arr[index].locked) return prev;
      const max = orientation === 'vertical' ? canvasWidth : stageHeight;
      const n = Math.round(Number(pos));
      if (!Number.isFinite(n)) return prev;
      const clamped = Math.max(0, Math.min(n, max || n));
      arr[index] = { ...arr[index], pos: clamped };
      return setCanvasGuides(prev, { vertical, horizontal });
    });
  }, [setDesign, canvasWidth, stageHeight]);

  const beginGuideDrag = useCallback((descriptor, clientX, clientY) => {
    setShowGuides(true);
    guideDragRef.current = descriptor;
    setGuideDrag(descriptor);
    const { value, removing } = computeGuideValue(descriptor.orientation, clientX, clientY);
    setGuidePreview({ value, removing });
  }, [computeGuideValue]);

  const startGuideFromRuler = useCallback((orientation, e) => {
    e.preventDefault();
    beginGuideDrag({ kind: 'create', orientation }, e.clientX, e.clientY);
  }, [beginGuideDrag]);

  const startGuideMove = useCallback((orientation, index, e) => {
    e.preventDefault();
    e.stopPropagation();
    // Task #1667: locked guides can't be dragged.
    const g = getCanvasGuides(design);
    const arr = orientation === 'vertical' ? g.vertical : g.horizontal;
    if (arr[index]?.locked) return;
    beginGuideDrag({ kind: 'move', orientation, index }, e.clientX, e.clientY);
  }, [beginGuideDrag, design]);

  // Window listeners while a guide is being dragged. Bound only on the
  // immutable descriptor so per-move value updates don't re-subscribe.
  useEffect(() => {
    if (!guideDrag) return;
    const descriptor = guideDrag;
    const endDrag = () => {
      guideDragRef.current = null;
      setGuideDrag(null);
      setGuidePreview(null);
    };
    const onMove = (e) => {
      const { value, removing } = computeGuideValue(descriptor.orientation, e.clientX, e.clientY);
      setGuidePreview({ value, removing });
    };
    const onUp = (e) => {
      const { value, removing } = computeGuideValue(descriptor.orientation, e.clientX, e.clientY);
      commitGuide(descriptor, value, removing);
      endDrag();
    };
    const onKey = (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (descriptor.kind === 'move') removeGuideAt(descriptor.orientation, descriptor.index);
        endDrag();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        endDrag();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [guideDrag, computeGuideValue, commitGuide, removeGuideAt]);

  const guideMoving = guideDrag && guideDrag.kind === 'move'
    ? { orientation: guideDrag.orientation, index: guideDrag.index }
    : null;
  const guidePending = guideDrag && guidePreview
    ? { orientation: guideDrag.orientation, value: guidePreview.value, removing: guidePreview.removing }
    : null;

  // ---- Pan (space+drag or middle-mouse drag) on stage wrapper ----
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panStateRef = useRef(null);

  useEffect(() => {
    const isFormField = (el) => {
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el.isContentEditable
      );
    };
    const onKeyDown = (e) => {
      if (e.code === 'Space' && !isFormField(e.target)) {
        if (!spaceHeld) setSpaceHeld(true);
        // Prevent page-scroll while panning is armed.
        e.preventDefault();
      }
    };
    const onKeyUp = (e) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [spaceHeld]);

  const handleStagePanPointerDown = useCallback((e) => {
    const middleClick = e.button === 1;
    if (!spaceHeld && !middleClick) return;
    const wrap = stageWrapperRef.current;
    if (!wrap) return;
    e.preventDefault();
    panStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: wrap.scrollLeft,
      scrollTop: wrap.scrollTop,
    };
    const onMove = (ev) => {
      const st = panStateRef.current;
      if (!st || !stageWrapperRef.current) return;
      stageWrapperRef.current.scrollLeft = st.scrollLeft - (ev.clientX - st.startX);
      stageWrapperRef.current.scrollTop = st.scrollTop - (ev.clientY - st.startY);
    };
    const onUp = () => {
      panStateRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [spaceHeld]);

  const canUndo = undoStack.current.length > 0;
  const canRedo = redoStack.current.length > 0;
  const hasAnySelect = selectedIds.length >= 1;
  const anchorName = anchorBlock?.name || 'anchor';
  const alignTarget = effectiveAlignRef === 'canvas'
    ? 'canvas'
    : effectiveAlignRef === 'selection'
      ? 'selection'
      : anchorName;
  const alignTargetLabel = effectiveAlignRef === 'canvas'
    ? 'Canvas'
    : effectiveAlignRef === 'selection'
      ? 'Selection'
      : anchorName;
  const alignTitle = (label) => `${label} (to ${alignTarget})`;

  return (
    <DndContext sensors={sensors} autoScroll={false} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
      <div className="flex flex-col h-full" data-testid="canvas-builder">
        {/* Sub-toolbar with alignment + undo/redo + grid */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 bg-white">
          <Button size="icon" variant="ghost" onClick={handleUndo} disabled={!canUndo} title="Undo" data-testid="button-undo">
            <Undo2 className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={handleRedo} disabled={!canRedo} title="Redo" data-testid="button-redo">
            <Redo2 className="w-4 h-4" />
          </Button>
          <div className="w-px h-6 bg-slate-200 mx-1" />
          <select
            className="h-8 text-xs border border-slate-200 rounded px-2 bg-white disabled:opacity-50"
            value={alignRef}
            onChange={(e) => setAlignRef(e.target.value)}
            disabled={!hasAnySelect}
            title="Alignment reference frame"
            aria-label="Alignment reference"
            data-testid="select-align-ref"
          >
            <option value="anchor">Align to: Anchor</option>
            <option value="selection">Align to: Selection</option>
            <option value="canvas">Align to: Canvas</option>
          </select>
          <Button size="icon" variant="ghost" onClick={() => alignSelected('left')} disabled={!hasAnySelect} title={alignTitle('Align left')} data-testid="button-align-left">
            <AlignLeft className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => alignSelected('hcenter')} disabled={!hasAnySelect} title={alignTitle('Align horizontal center')} data-testid="button-align-hcenter">
            <AlignCenter className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => alignSelected('right')} disabled={!hasAnySelect} title={alignTitle('Align right')} data-testid="button-align-right">
            <AlignRight className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => alignSelected('top')} disabled={!hasAnySelect} title={alignTitle('Align top')} data-testid="button-align-top">
            <AlignStartVertical className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => alignSelected('vcenter')} disabled={!hasAnySelect} title={alignTitle('Align vertical center')} data-testid="button-align-vcenter">
            <AlignCenterVertical className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => alignSelected('bottom')} disabled={!hasAnySelect} title={alignTitle('Align bottom')} data-testid="button-align-bottom">
            <AlignEndVertical className="w-4 h-4" />
          </Button>
          {hasAnySelect && selectedIds.length < 2 && (
            <Badge variant="secondary" className="ml-1" data-testid="badge-align-target">
              {alignTargetLabel}
            </Badge>
          )}
          {selectedIds.length >= 2 && (
            <div className="flex items-center gap-1 ml-1" data-testid="align-anchor-picker">
              <span className="text-xs text-slate-500">Align to:</span>
              <select
                className="h-8 text-xs border border-slate-200 rounded px-2 bg-white max-w-[12rem]"
                value={anchorId || ''}
                onChange={(e) => setManualAnchorId(e.target.value || null)}
                aria-label="Anchor block to align to"
                data-testid="select-align-anchor"
              >
                {selectedIds.map((id, idx) => {
                  const b = children.find((c) => c.id === id);
                  if (!b) return null;
                  const isImplicit = idx === selectedIds.length - 1;
                  return (
                    <option key={id} value={id} data-testid={`option-align-anchor-${id}`}>
                      {b.name || b.type}{isImplicit ? ' (last selected)' : ''}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
          <div className="w-px h-6 bg-slate-200 mx-1" />
          <Button size="icon" variant="ghost" onClick={() => distributeSelected('h')} disabled={selectedIds.length < 3} title="Distribute horizontally" data-testid="button-distribute-h">
            <AlignHorizontalDistributeCenter className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => distributeSelected('v')} disabled={selectedIds.length < 3} title="Distribute vertically" data-testid="button-distribute-v">
            <AlignVerticalDistributeCenter className="w-4 h-4" />
          </Button>
          <div className="w-px h-6 bg-slate-200 mx-1" />
          <Button size="icon" variant="ghost" onClick={groupSelected} disabled={!canGroupSelection} title="Group (Ctrl/Cmd+G)" data-testid="button-group">
            <GroupIcon className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={ungroupSelected} disabled={!canUngroupSelection} title="Ungroup (Ctrl/Cmd+Shift+G)" data-testid="button-ungroup">
            <UngroupIcon className="w-4 h-4" />
          </Button>
          <div className="w-px h-6 bg-slate-200 mx-1" />
          <Button size="icon" variant="ghost" onClick={duplicateSelected} disabled={selectedIds.length === 0} title="Duplicate" data-testid="button-duplicate-selected">
            <Copy className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={deleteSelected} disabled={selectedIds.length === 0} title="Delete" data-testid="button-delete-selected">
            <Trash2 className="w-4 h-4" />
          </Button>
          <div className="w-px h-6 bg-slate-200 mx-1" />
          <Button
            size="sm" variant="ghost"
            onClick={handleAutoBuildClick}
            title="Automatically build tablet & mobile layouts from the desktop layout"
            data-testid="button-auto-build"
          >
            <Wand2 className="w-4 h-4 mr-1.5" /> Auto build
          </Button>
          <div className="flex-1" />
          <Button
            size="sm" variant="ghost"
            onClick={() => setShowLayersPanel((v) => !v)}
            className={`toggle-elevate ${showLayersPanel ? 'toggle-elevated' : ''}`}
            aria-pressed={showLayersPanel}
            title="Show/hide the Layers panel"
            data-testid="button-toggle-layers"
          >
            <Layers className="w-4 h-4 mr-1.5" /> Layers
          </Button>
          <Button
            size="sm" variant="ghost"
            onClick={() => setShowReadingOrder((v) => !v)}
            className={`toggle-elevate ${showReadingOrder ? 'toggle-elevated' : ''}`}
            aria-pressed={showReadingOrder}
            title="Show reading (DOM/tab) order"
            data-testid="button-toggle-reading-order"
          >
            <ListOrdered className="w-4 h-4 mr-1.5" /> Order
          </Button>
          <Button
            size="sm" variant="ghost"
            onClick={() => setShowA11yPanel((v) => !v)}
            className={`toggle-elevate ${showA11yPanel ? 'toggle-elevated' : ''}`}
            aria-pressed={showA11yPanel}
            title="Show accessibility audit"
            data-testid="button-toggle-a11y"
          >
            <Accessibility className="w-4 h-4 mr-1.5" />
            A11y
            {a11yIssues.length > 0 && (
              <Badge
                variant="outline"
                className={`ml-1.5 ${
                  a11yIssues.some((i) => i.severity === 'error')
                    ? 'border-destructive/40 text-destructive'
                    : ''
                }`}
                data-testid="badge-a11y-issue-count"
              >
                {a11yIssues.length}
              </Badge>
            )}
          </Button>
          <Button
            size="sm" variant="ghost"
            onClick={() => setShowGrid((v) => !v)}
            className={`toggle-elevate ${showGrid ? 'toggle-elevated' : ''}`}
            aria-pressed={showGrid}
            data-testid="button-toggle-grid"
          >
            <Grid3x3 className="w-4 h-4 mr-1.5" /> Grid
          </Button>
          <select
            className="h-8 text-xs border border-slate-200 rounded px-2 bg-white"
            value={gridSize}
            onChange={(e) => setGridSize(Number(e.target.value))}
            data-testid="select-grid-size"
            aria-label="Grid size"
          >
            {[1, 4, 8, 16, 24, 32].map((g) => (
              <option key={g} value={g}>{g}px grid</option>
            ))}
          </select>
          <Button
            size="sm" variant="ghost"
            onClick={() => setShowGuides((v) => !v)}
            className={`toggle-elevate ${showGuides ? 'toggle-elevated' : ''}`}
            aria-pressed={showGuides}
            title="Show/hide ruler guides"
            data-testid="button-toggle-guides"
          >
            <Ruler className="w-4 h-4 mr-1.5" /> Guides
          </Button>
          <Button
            size="icon" variant="ghost"
            onClick={clearGuides}
            disabled={!hasGuides}
            title="Clear all guides"
            data-testid="button-clear-guides"
          >
            <Eraser className="w-4 h-4" />
          </Button>
          <div className="w-px h-6 bg-slate-200 mx-1" />
          <Button size="icon" variant="ghost" onClick={zoomOut} title="Zoom out" data-testid="button-zoom-out">
            <ZoomOut className="w-4 h-4" />
          </Button>
          <button
            type="button"
            onClick={resetZoom}
            className="h-8 px-2 text-xs rounded hover:bg-slate-100 tabular-nums min-w-[3.5rem]"
            title="Reset zoom"
            data-testid="button-zoom-reset"
          >
            {Math.round(zoom * 100)}%
          </button>
          <Button size="icon" variant="ghost" onClick={zoomIn} title="Zoom in" data-testid="button-zoom-in">
            <ZoomIn className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={resetZoom} title="Fit to 100%" data-testid="button-zoom-fit">
            <Maximize2 className="w-4 h-4" />
          </Button>
        </div>

        {/* Main layout */}
        <div className="flex-1 flex min-h-0 relative">
          {/* Palette */}
          <aside
            className="w-56 border-r border-slate-200 bg-white p-3 overflow-y-auto"
            aria-label="Block palette"
            data-testid="panel-palette"
          >
            <h2 className="text-sm font-semibold text-slate-900 mb-2">Blocks</h2>
            <CanvasPalette />
            {showA11yPanel && (
              <div className="mt-6 pt-4 border-t border-slate-200">
                <CanvasA11yPanel
                  issues={a11yIssues}
                  selectedIds={selectedIds}
                  onJumpToBlock={(id) => {
                    setSelectedIds([id]);
                    const el = document.querySelector(`[data-testid="canvas-block-${id}"]`);
                    if (el && typeof el.scrollIntoView === 'function') {
                      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                  }}
                  onLocate={onLocateIssue}
                />
              </div>
            )}
          </aside>

          {/* Stage */}
          <main
            className="flex-1 overflow-auto p-6 bg-slate-100"
            ref={stageWrapperRef}
            data-testid="panel-stage"
            onPointerDown={handleStagePanPointerDown}
            style={{ cursor: spaceHeld ? (panStateRef.current ? 'grabbing' : 'grab') : undefined }}
          >
            <div className="mx-auto" style={{ width: 'fit-content' }}>
              <div className="text-xs text-slate-700 mb-2 flex items-center gap-2">
                <Square className="w-3 h-3" />
                {canvasWidth}px × {breakpoint} · {Math.round(zoom * 100)}%
                {selectedIds.length > 0 && (
                  <Badge variant="outline" className="ml-1">
                    {selectedIds.length} selected
                  </Badge>
                )}
              </div>
              <CanvasRulers
                width={canvasWidth}
                height={stageHeight}
                gridSize={gridSize}
                zoom={zoom}
                onCreateGuide={startGuideFromRuler}
              >
                <div
                  ref={guideAreaRef}
                  className="relative"
                  style={{
                    width: canvasWidth * zoom,
                    height: stageHeight * zoom,
                  }}
                >
                  <div
                    style={{
                      transform: `scale(${zoom})`,
                      transformOrigin: 'top left',
                      width: canvasWidth * zoom,
                      height: stageHeight * zoom,
                    }}
                  >
                    <CanvasSymbolsProvider>
                    <CanvasStage
                      blocks={displayChildren}
                      selectedIds={selectedIds}
                      anchorId={anchorId}
                      expandSelection={expandSelectionToGroups}
                      onGroup={groupSelected}
                      onUngroup={ungroupSelected}
                      canGroup={canGroupSelection}
                      canUngroup={canUngroupSelection}
                      breakpoint={breakpoint}
                      canvasWidth={canvasWidth}
                      canvasHeight={stageHeight}
                      gridSize={gridSize}
                      showGrid={showGrid}
                      zoom={zoom}
                      showReadingOrder={showReadingOrder}
                      issuesByBlock={a11yIssuesByBlock}
                      userGuides={showGuides ? guidePositions : EMPTY_GUIDES}
                      onSelect={handleSelect}
                      onApplyGeometry={applyGeometry}
                      onMarqueeSelect={handleMarqueeSelect}
                      onPreviewBottomChange={setLivePreviewBottom}
                      onCommitAutoHeight={commitAutoHeight}
                      scrollContainerRef={stageWrapperRef}
                    />
                    </CanvasSymbolsProvider>
                  </div>
                  <CanvasGuidesOverlay
                    guides={guides}
                    pending={guidePending}
                    moving={guideMoving}
                    show={showGuides}
                    zoom={zoom}
                    canvasWidth={canvasWidth}
                    stageHeight={stageHeight}
                    onGuidePointerDown={startGuideMove}
                    onToggleGuideLock={toggleGuideLock}
                    onSetGuidePosition={setGuidePosition}
                  />
                </div>
              </CanvasRulers>
            </div>
          </main>

          {/* Inspector */}
          <aside
            className="w-72 border-l border-slate-200 bg-white p-3 overflow-y-auto"
            aria-label="Inspector"
            data-testid="panel-inspector"
          >
            <CanvasAnchorProvider design={design} pages={otherPages}>
            <CanvasEditorPageProvider micrositeId={micrositeId}>
            <CanvasInspector
              selectedBlocks={selectedBlocks}
              breakpoint={breakpoint}
              blockIssues={
                selectedBlocks.length === 1
                  ? (a11yIssuesByBlock.get(selectedBlocks[0].id) || [])
                  : []
              }
              onUpdateBlock={updateBlock}
              onToggleLocked={toggleLockedById}
              onToggleHidden={toggleHiddenById}
              onClearOverride={clearOverrideById}
              onReorderBlock={moveBlockInReadingOrder}
              onUnlinkSymbol={onUnlinkSymbol}
              readingOrderIndex={
                selectedBlocks.length === 1
                  ? children.findIndex((b) => b.id === selectedBlocks[0].id)
                  : -1
              }
              readingOrderTotal={children.length}
            />
            </CanvasEditorPageProvider>
            </CanvasAnchorProvider>
          </aside>

          {/* Floating, draggable Layers panel (moved out of the narrow left sidebar). */}
          {showLayersPanel && (
            <CanvasFloatingPanel
              title="Layers"
              icon={<Layers className="w-4 h-4 text-slate-500 shrink-0" />}
              onClose={() => setShowLayersPanel(false)}
              defaultPosition={{ x: 16, y: 16 }}
              width={340}
              testId="floating-layers-panel"
              storageKey="canvas.layersPanel.position"
            >
              <CanvasLayers
                blocks={children}
                groups={groups}
                selectedIds={selectedIds}
                breakpoint={breakpoint}
                issuesByBlock={a11yIssuesByBlock}
                onSelect={handleSelect}
                onReorder={handleReorderLayers}
                onToggleHidden={toggleHiddenById}
                onToggleLocked={toggleLockedById}
                onDelete={deleteById}
                onDuplicate={duplicateById}
                onRename={renameById}
                onSelectGroup={selectGroup}
                onRenameGroup={renameGroup}
                onToggleGroupCollapsed={toggleGroupCollapsed}
                onToggleGroupHidden={toggleGroupHidden}
                onToggleGroupLocked={toggleGroupLocked}
                onUngroup={ungroupById}
              />
            </CanvasFloatingPanel>
          )}
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {activeDragId && activeDragType ? (
          <div className="px-3 py-2 rounded-md bg-white border border-primary shadow-md text-sm flex items-center gap-2">
            <Square className="w-4 h-4 text-primary" />
            <span>New {activeDragType}</span>
          </div>
        ) : null}
      </DragOverlay>

      {/* Task #2434: confirm before replacing existing tablet/mobile overrides. */}
      <AlertDialog open={showAutoBuildConfirm} onOpenChange={setShowAutoBuildConfirm}>
        <AlertDialogContent data-testid="dialog-auto-build-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Replace tablet &amp; mobile layouts?</AlertDialogTitle>
            <AlertDialogDescription>
              Some blocks already have their own tablet or mobile positions.
              Auto build will replace those with freshly generated layouts based
              on the current desktop layout. Blocks you have hidden per
              breakpoint stay hidden, and the desktop layout is not changed.
              You can undo this in one step.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-auto-build-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setShowAutoBuildConfirm(false); runAutoBuild(); }}
              data-testid="button-auto-build-confirm"
            >
              Replace layouts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DndContext>
  );
});

export default CanvasBuilder;

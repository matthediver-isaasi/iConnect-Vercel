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
  Square,
  ZoomIn,
  ZoomOut,
  Maximize2,
  ListOrdered,
  Accessibility,
} from 'lucide-react';
import {
  createBlock,
  normalizeCanvasDesign,
  resolveBlockAtBreakpoint,
  setBlockBp,
  clearBpOverride,
  getRootChildren,
  setRootChildren,
  BREAKPOINT_WIDTHS,
  BLOCK_TYPES,
} from '@/lib/canvasDesign';
import CanvasPalette from './CanvasPalette';
import CanvasStage from './CanvasStage';
import CanvasInspector from './CanvasInspector';
import CanvasLayers from './CanvasLayers';
import CanvasA11yPanel from './CanvasA11yPanel';
import {
  auditCanvasDesign,
  issuesByBlock as buildIssuesByBlock,
  suggestHeadingLevel,
  headingFieldFor,
} from '@/lib/canvasA11y';

const BREAKPOINTS = [
  { id: 'desktop', label: 'Desktop', icon: Monitor },
  { id: 'tablet', label: 'Tablet', icon: Tablet },
  { id: 'mobile', label: 'Mobile', icon: Smartphone },
];

const STAGE_MIN_HEIGHT = 800;

const RULER_SIZE = 20;

function CanvasRulers({ width, height, gridSize, zoom = 1, children }) {
  // Tick every gridSize*N where N is chosen to keep ticks readable at zoom.
  const baseStep = Math.max(gridSize, 8);
  const labelEvery = Math.max(1, Math.round(40 / (baseStep * zoom)));
  const step = baseStep;
  const labelStep = step * labelEvery;
  const widthScaled = width * zoom;
  const heightScaled = height * zoom;
  const hTicks = [];
  for (let x = 0; x <= width; x += step) hTicks.push(x);
  const vTicks = [];
  for (let y = 0; y <= height; y += step) vTicks.push(y);

  return (
    <div
      className="relative"
      style={{ paddingTop: RULER_SIZE, paddingLeft: RULER_SIZE }}
      data-testid="canvas-rulers"
    >
      {/* Corner */}
      <div
        className="absolute top-0 left-0 bg-slate-200 border-r border-b border-slate-300"
        style={{ width: RULER_SIZE, height: RULER_SIZE, zIndex: 2 }}
      />
      {/* Top ruler */}
      <div
        className="absolute top-0 bg-white border-b border-slate-300 overflow-hidden"
        style={{ left: RULER_SIZE, width: widthScaled, height: RULER_SIZE }}
        data-testid="ruler-horizontal"
      >
        {hTicks.map((x) => {
          const isLabel = x % labelStep === 0;
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
      </div>
      {/* Left ruler */}
      <div
        className="absolute left-0 bg-white border-r border-slate-300 overflow-hidden"
        style={{ top: RULER_SIZE, width: RULER_SIZE, height: heightScaled }}
        data-testid="ruler-vertical"
      >
        {vTicks.map((y) => {
          const isLabel = y % labelStep === 0;
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
      </div>
      <div>{children}</div>
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
      const created = arr.map((b) => createBlock(b.type || BLOCK_TYPES.BOX, b));
      replaceChildren((existing) => [...existing, ...created]);
      const newIds = created.map((c) => c.id);
      setSelectedIds(newIds);
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
          const el = document.querySelector(`[data-block-id="${arr[0]}"]`);
          if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 50);
      }
    },
  }), [performSave, design, lastSavedSnapshot, replaceChildren, selectedIds, children]);

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
      setSelectedIds(idsOrId);
      return;
    }
    if (additive) {
      setSelectedIds((prev) => prev.includes(idsOrId)
        ? prev.filter((x) => x !== idsOrId)
        : [...prev, idsOrId]);
    } else {
      setSelectedIds([idsOrId]);
    }
  }, []);

  const handleMarqueeSelect = useCallback((ids, additive) => {
    if (additive) {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...ids])));
    } else {
      setSelectedIds(ids);
    }
  }, []);

  // ---- Geometry commit (after drag/resize) ----
  const applyGeometry = useCallback((updates) => {
    replaceChildren((arr) => arr.map((b) => {
      const u = updates[b.id];
      if (!u) return b;
      // Round to integers for clean serialization. Full-width blocks
      // ignore horizontal geometry (x/w are derived from the canvas).
      const patch = b.fullWidth
        ? { y: Math.round(u.y), h: Math.round(u.h) }
        : {
            x: Math.round(u.x), y: Math.round(u.y),
            w: Math.round(u.w), h: Math.round(u.h),
          };
      return setBlockBp(b, breakpoint, patch);
    }));
  }, [replaceChildren, breakpoint]);

  // ---- DnD palette -> canvas ----
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const stageWrapperRef = useRef(null);

  const handleDragStart = (event) => {
    setActiveDragId(event.active.id);
    setActiveDragType(event.active.data?.current?.type || null);
  };

  const handleDragEnd = (event) => {
    setActiveDragId(null);
    setActiveDragType(null);
    const { active, over } = event;
    if (!over) return;
    const fromPalette = active.data?.current?.fromPalette;
    if (!fromPalette) return;
    if (over.id !== 'canvas-drop-zone') return;

    // Compute drop coords relative to stage. The stage element is
    // CSS-scaled by `zoom`, so getBoundingClientRect() returns scaled
    // dimensions; divide pointer offsets by zoom to get internal
    // (unscaled) canvas coordinates.
    let x = 40, y = 40;
    const stage = document.querySelector('[data-testid="canvas-stage"]');
    if (stage && event.activatorEvent) {
      const rect = stage.getBoundingClientRect();
      const last = event.delta;
      const finalX = (event.activatorEvent.clientX || 0) + (last?.x || 0);
      const finalY = (event.activatorEvent.clientY || 0) + (last?.y || 0);
      const zoomFactor = zoom || 1;
      const localX = (finalX - rect.left) / zoomFactor - 50;
      const localY = (finalY - rect.top) / zoomFactor - 30;
      x = Math.max(0, Math.round(localX / gridSize) * gridSize);
      y = Math.max(0, Math.round(localY / gridSize) * gridSize);
    }

    const newType = active.data?.current?.type || BLOCK_TYPES.BOX;
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

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore when typing in inputs
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;

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
  }, [handleUndo, handleRedo, duplicateSelected, deleteSelected, selectedIds, children, breakpoint, applyGeometry, gridSize]);

  // ---- Align / distribute ----
  // With 2+ blocks selected the most-recently-selected id (last in
  // `selectedIds`) is treated as the **anchor** — other selected blocks
  // align to its edges/center (Figma/Sketch "select anchor last" pattern).
  // The anchor itself does not move. With a single selection we still
  // align that block to the canvas bounds.
  // Manual override wins when the user has explicitly picked an anchor
  // from the dropdown and that block is still selected. Otherwise we
  // fall back to the implicit "last selected = anchor" rule.
  const anchorId = selectedIds.length >= 2
    ? (manualAnchorId && selectedIds.includes(manualAnchorId)
        ? manualAnchorId
        : selectedIds[selectedIds.length - 1])
    : null;
  const anchorBlock = useMemo(
    () => (anchorId ? children.find((b) => b.id === anchorId) : null),
    [anchorId, children],
  );

  const alignSelected = useCallback((mode) => {
    if (selectedIds.length < 1) return;
    const blocksGeom = selectedIds
      .map((id) => {
        const b = children.find((c) => c.id === id);
        if (!b) return null;
        return { id, geom: resolveBlockAtBreakpoint(b, breakpoint) };
      })
      .filter(Boolean);
    if (blocksGeom.length < 1) return;

    // Determine the alignment reference frame:
    //  - Single select  -> canvas bounds.
    //  - Multi  select  -> the anchor block's bounds (last selected).
    let minX, maxRight, minY, maxBottom;
    if (blocksGeom.length === 1) {
      const cW = BREAKPOINT_WIDTHS[breakpoint] || BREAKPOINT_WIDTHS.desktop;
      const cH = STAGE_MIN_HEIGHT;
      minX = 0;
      maxRight = cW;
      minY = 0;
      maxBottom = cH;
    } else {
      const anchor = blocksGeom.find((b) => b.id === anchorId) || blocksGeom[blocksGeom.length - 1];
      minX = anchor.geom.x;
      maxRight = anchor.geom.x + anchor.geom.w;
      minY = anchor.geom.y;
      maxBottom = anchor.geom.y + anchor.geom.h;
    }
    const centerX = (minX + maxRight) / 2;
    const centerY = (minY + maxBottom) / 2;
    const updates = {};
    for (const { id, geom } of blocksGeom) {
      // Never move the anchor itself.
      if (blocksGeom.length > 1 && id === anchorId) continue;
      let nx = geom.x, ny = geom.y;
      if (mode === 'left') nx = minX;
      if (mode === 'right') nx = maxRight - geom.w;
      if (mode === 'hcenter') nx = Math.round(centerX - geom.w / 2);
      if (mode === 'top') ny = minY;
      if (mode === 'bottom') ny = maxBottom - geom.h;
      if (mode === 'vcenter') ny = Math.round(centerY - geom.h / 2);
      updates[id] = { x: nx, y: ny, w: geom.w, h: geom.h };
    }
    if (Object.keys(updates).length > 0) applyGeometry(updates);
  }, [selectedIds, anchorId, children, breakpoint, applyGeometry]);

  const distributeSelected = useCallback((axis) => {
    if (selectedIds.length < 3) return;
    const items = selectedIds
      .map((id) => {
        const b = children.find((c) => c.id === id);
        if (!b) return null;
        return { id, geom: resolveBlockAtBreakpoint(b, breakpoint) };
      })
      .filter(Boolean);
    if (items.length < 3) return;
    const key = axis === 'h' ? 'x' : 'y';
    const sizeKey = axis === 'h' ? 'w' : 'h';
    items.sort((a, b) => (a.geom[key] + a.geom[sizeKey] / 2) - (b.geom[key] + b.geom[sizeKey] / 2));
    const first = items[0];
    const last = items[items.length - 1];
    const firstCenter = first.geom[key] + first.geom[sizeKey] / 2;
    const lastCenter = last.geom[key] + last.geom[sizeKey] / 2;
    const step = (lastCenter - firstCenter) / (items.length - 1);
    const updates = {};
    items.forEach((it, idx) => {
      if (idx === 0 || idx === items.length - 1) return;
      const targetCenter = firstCenter + step * idx;
      const target = Math.round(targetCenter - it.geom[sizeKey] / 2);
      updates[it.id] = {
        ...it.geom,
        [key]: target,
      };
    });
    applyGeometry(updates);
  }, [selectedIds, children, breakpoint, applyGeometry]);

  const canvasWidth = BREAKPOINT_WIDTHS[breakpoint] || BREAKPOINT_WIDTHS.desktop;

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
  const alignTarget = selectedIds.length === 1
    ? 'canvas'
    : (anchorBlock ? anchorName : 'selection');
  const alignTitle = (label) => `${label} (to ${alignTarget})`;

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
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
              Align to: Canvas
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
          <Button size="icon" variant="ghost" onClick={duplicateSelected} disabled={selectedIds.length === 0} title="Duplicate" data-testid="button-duplicate-selected">
            <Copy className="w-4 h-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={deleteSelected} disabled={selectedIds.length === 0} title="Delete" data-testid="button-delete-selected">
            <Trash2 className="w-4 h-4" />
          </Button>
          <div className="flex-1" />
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
        <div className="flex-1 flex min-h-0">
          {/* Palette */}
          <aside
            className="w-56 border-r border-slate-200 bg-white p-3 overflow-y-auto"
            aria-label="Block palette"
            data-testid="panel-palette"
          >
            <h2 className="text-sm font-semibold text-slate-900 mb-2">Blocks</h2>
            <CanvasPalette />
            <div className="mt-6">
              <CanvasLayers
                blocks={children}
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
              />
            </div>
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
              <div className="text-xs text-slate-500 mb-2 flex items-center gap-2">
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
                height={STAGE_MIN_HEIGHT}
                gridSize={gridSize}
                zoom={zoom}
              >
                <div
                  style={{
                    transform: `scale(${zoom})`,
                    transformOrigin: 'top left',
                    width: canvasWidth * zoom,
                    height: STAGE_MIN_HEIGHT * zoom,
                  }}
                >
                  <CanvasStage
                    blocks={children}
                    selectedIds={selectedIds}
                    anchorId={anchorId}
                    breakpoint={breakpoint}
                    canvasWidth={canvasWidth}
                    canvasHeight={STAGE_MIN_HEIGHT}
                    gridSize={gridSize}
                    showGrid={showGrid}
                    zoom={zoom}
                    showReadingOrder={showReadingOrder}
                    issuesByBlock={a11yIssuesByBlock}
                    onSelect={handleSelect}
                    onApplyGeometry={applyGeometry}
                    onMarqueeSelect={handleMarqueeSelect}
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
              readingOrderIndex={
                selectedBlocks.length === 1
                  ? children.findIndex((b) => b.id === selectedBlocks[0].id)
                  : -1
              }
              readingOrderTotal={children.length}
            />
          </aside>
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
    </DndContext>
  );
});

export default CanvasBuilder;

import { useState, useRef, useEffect, useCallback } from 'react';
import { X, GripHorizontal } from 'lucide-react';

const PANEL_WIDTH = 340;
const MIN_WIDTH = 260;
const MIN_HEIGHT = 200;

// Read a persisted {x, y} position for the given storage key. Returns null when
// nothing valid is stored (or when localStorage is unavailable).
function readStoredPosition(storageKey) {
  if (!storageKey || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y)
    ) {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    // Ignore malformed JSON / storage access errors and fall back to default.
  }
  return null;
}

// A lightweight floating, draggable window. It positions itself absolutely
// within its offset parent (the editor main area) and can be moved by dragging
// its header. Movement is clamped so the panel never leaves the viewport.
// When `storageKey` is supplied, the last-dragged position is persisted to
// localStorage so it survives editor reloads (per-user/local only).
// Its right/bottom edges and bottom-right corner can be dragged to resize it;
// resizing is clamped so the panel stays on screen and respects a min size.
export default function CanvasFloatingPanel({
  title,
  icon,
  onClose,
  children,
  defaultPosition = { x: 16, y: 16 },
  width = PANEL_WIDTH,
  testId = 'floating-panel',
  storageKey,
}) {
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const resizeState = useRef(null);
  const [pos, setPos] = useState(() => readStoredPosition(storageKey) || defaultPosition);
  // `null` height means "auto" (grow with content up to maxHeight) until the
  // user resizes explicitly.
  const [size, setSize] = useState({ width, height: null });

  const clampToParent = useCallback((x, y) => {
    const panel = panelRef.current;
    const parent = panel?.offsetParent;
    if (!panel || !parent) return { x, y };
    const maxX = Math.max(0, parent.clientWidth - panel.offsetWidth);
    const maxY = Math.max(0, parent.clientHeight - panel.offsetHeight);
    return {
      x: Math.min(Math.max(0, x), maxX),
      y: Math.min(Math.max(0, y), maxY),
    };
  }, []);

  const handlePointerMove = useCallback((e) => {
    const ds = dragState.current;
    if (!ds) return;
    setPos(clampToParent(e.clientX - ds.offsetX, e.clientY - ds.offsetY));
  }, [clampToParent]);

  const persistPosition = useCallback((p) => {
    if (!storageKey || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ x: p.x, y: p.y }));
    } catch {
      // Ignore storage quota / access errors — persistence is best-effort.
    }
  }, [storageKey]);

  const handlePointerUp = useCallback(() => {
    dragState.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    setPos((p) => {
      persistPosition(p);
      return p;
    });
  }, [handlePointerMove, persistPosition]);

  const handleHeaderPointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    const parent = panel?.offsetParent;
    if (!panel || !parent) return;
    const parentRect = parent.getBoundingClientRect();
    dragState.current = {
      offsetX: e.clientX - (parentRect.left + pos.x),
      offsetY: e.clientY - (parentRect.top + pos.y),
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    e.preventDefault();
  }, [pos, handlePointerMove, handlePointerUp]);

  const handleResizeMove = useCallback((e) => {
    const rs = resizeState.current;
    if (!rs) return;
    const panel = panelRef.current;
    const parent = panel?.offsetParent;
    let nextWidth = rs.startWidth;
    let nextHeight = rs.startHeight;
    if (rs.axis === 'x' || rs.axis === 'both') {
      const maxWidth = parent
        ? Math.max(MIN_WIDTH, parent.clientWidth - pos.x)
        : Infinity;
      nextWidth = Math.min(
        Math.max(MIN_WIDTH, rs.startWidth + (e.clientX - rs.startX)),
        maxWidth,
      );
    }
    if (rs.axis === 'y' || rs.axis === 'both') {
      const maxHeight = parent
        ? Math.max(MIN_HEIGHT, parent.clientHeight - pos.y)
        : Infinity;
      nextHeight = Math.min(
        Math.max(MIN_HEIGHT, rs.startHeight + (e.clientY - rs.startY)),
        maxHeight,
      );
    }
    setSize({ width: nextWidth, height: nextHeight });
  }, [pos]);

  const handleResizeUp = useCallback(() => {
    resizeState.current = null;
    window.removeEventListener('pointermove', handleResizeMove);
    window.removeEventListener('pointerup', handleResizeUp);
  }, [handleResizeMove]);

  const startResize = useCallback((axis) => (e) => {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    resizeState.current = {
      axis,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: panel.offsetWidth,
      startHeight: panel.offsetHeight,
    };
    window.addEventListener('pointermove', handleResizeMove);
    window.addEventListener('pointerup', handleResizeUp);
    e.preventDefault();
    e.stopPropagation();
  }, [handleResizeMove, handleResizeUp]);

  // Keep the panel on screen if the container resizes.
  useEffect(() => {
    const onResize = () => setPos((p) => clampToParent(p.x, p.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampToParent]);

  useEffect(() => () => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointermove', handleResizeMove);
    window.removeEventListener('pointerup', handleResizeUp);
  }, [handlePointerMove, handlePointerUp, handleResizeMove, handleResizeUp]);

  return (
    <div
      ref={panelRef}
      className="absolute z-50 flex flex-col rounded-md border border-slate-200 bg-white shadow-lg"
      style={{
        left: pos.x,
        top: pos.y,
        width: size.width,
        height: size.height ?? undefined,
        maxHeight: 'calc(100% - 32px)',
      }}
      data-testid={testId}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 bg-slate-50 rounded-t-md cursor-grab active:cursor-grabbing select-none"
        onPointerDown={handleHeaderPointerDown}
        data-testid={`${testId}-header`}
      >
        <GripHorizontal className="w-4 h-4 text-slate-400 shrink-0" />
        {icon}
        <h2 className="flex-1 min-w-0 truncate text-sm font-semibold text-slate-900">{title}</h2>
        <button
          type="button"
          className="p-0.5 rounded hover:bg-slate-200 shrink-0"
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          title="Close"
          aria-label="Close"
          data-testid={`${testId}-close`}
        >
          <X className="w-4 h-4 text-slate-500" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {children}
      </div>

      {/* Right edge resize handle */}
      <div
        className="absolute top-2 bottom-2 right-0 w-1.5 cursor-ew-resize"
        onPointerDown={startResize('x')}
        title="Drag to resize width"
        data-testid={`${testId}-resize-right`}
      />
      {/* Bottom edge resize handle */}
      <div
        className="absolute left-2 right-2 bottom-0 h-1.5 cursor-ns-resize"
        onPointerDown={startResize('y')}
        title="Drag to resize height"
        data-testid={`${testId}-resize-bottom`}
      />
      {/* Bottom-right corner resize handle */}
      <div
        className="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize"
        onPointerDown={startResize('both')}
        title="Drag to resize"
        data-testid={`${testId}-resize-corner`}
      >
        <svg viewBox="0 0 10 10" className="w-full h-full text-slate-400" aria-hidden="true">
          <path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </div>
    </div>
  );
}

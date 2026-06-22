// Task #1665 / #1667: editor-only ruler guides overlay.
//
// Rendered OUTSIDE the zoom-scaled stage (positioned over it in screen pixels),
// so guide lines stay crisp 1px and the coordinate readout keeps a natural font
// size at any zoom. Stage coordinates are converted to screen pixels by
// multiplying by `zoom`. The container is click-through (`pointer-events-none`);
// only the grab strips and the per-guide chips opt back in so clicks elsewhere
// reach the blocks below.
//
// Each stored guide is `{ pos, locked }`. A small chip near the ruler origin
// shows the px position, a lock toggle, and accepts an exact typed position
// (double-click the value). Locked guides can't be dragged or have their
// position typed; they still act as snap targets (handled in the stage).

import { useState } from 'react';
import { Lock, Unlock } from 'lucide-react';

const GUIDE_COLOR = '#06b6d4'; // cyan — distinct from the pink sibling-snap highlight
const LOCKED_COLOR = '#64748b'; // slate — locked guides read as "fixed"
const REMOVE_COLOR = '#ef4444'; // red — shown when a drag would remove the guide
const GRAB = 9; // screen-px width of the transparent grab strip

function Readout({ orientation, value, left, top, removing }) {
  const style = orientation === 'vertical'
    ? { left, top: 2 }
    : { left: 2, top };
  return (
    <div
      className="absolute rounded-sm px-1 py-0.5 text-[10px] font-semibold text-white tabular-nums whitespace-nowrap"
      style={{ ...style, background: removing ? REMOVE_COLOR : GUIDE_COLOR, transform: orientation === 'vertical' ? 'translateX(3px)' : 'translateY(3px)', zIndex: 2 }}
      data-testid="guide-readout"
    >
      {removing ? 'Release to remove' : `${Math.round(value)}px`}
    </div>
  );
}

// Interactive chip anchored at a stored guide's ruler-origin end. Shows the
// position, a lock toggle, and an inline numeric editor.
function GuideChip({ orientation, index, value, locked, left, top, onToggleLock, onSetPosition }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const posStyle = orientation === 'vertical' ? { left, top: 2 } : { left: 2, top };
  const translate = orientation === 'vertical' ? 'translateX(3px)' : 'translateY(3px)';

  const startEdit = () => {
    if (locked) return;
    setDraft(String(value));
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const n = Number(draft);
    if (Number.isFinite(n)) onSetPosition?.(orientation, index, n);
  };
  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
  };

  return (
    <div
      className="absolute pointer-events-auto flex items-center gap-0.5 rounded-sm px-1 py-0.5 text-[10px] font-semibold text-white tabular-nums whitespace-nowrap"
      style={{ ...posStyle, background: locked ? LOCKED_COLOR : GUIDE_COLOR, transform: translate, zIndex: 3 }}
      // Don't let chip clicks start a guide drag or reach the blocks below.
      onPointerDown={(e) => e.stopPropagation()}
      data-testid={`guide-chip-${orientation}-${index}`}
    >
      <button
        type="button"
        className="flex items-center justify-center rounded-sm hover:bg-white/20 active:bg-white/30"
        style={{ width: 14, height: 14 }}
        onClick={() => onToggleLock?.(orientation, index)}
        title={locked ? 'Unlock guide' : 'Lock guide'}
        aria-pressed={locked}
        data-testid={`button-guide-lock-${orientation}-${index}`}
      >
        {locked ? <Lock style={{ width: 10, height: 10 }} /> : <Unlock style={{ width: 10, height: 10 }} />}
      </button>
      {editing ? (
        <input
          type="number"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
          className="w-12 bg-white/95 text-slate-900 rounded-sm px-1 outline-none tabular-nums"
          style={{ height: 14 }}
          data-testid={`input-guide-position-${orientation}-${index}`}
        />
      ) : (
        <span
          className={locked ? 'cursor-default' : 'cursor-text'}
          onDoubleClick={startEdit}
          title={locked ? 'Unlock to edit position' : 'Double-click to set exact position'}
          data-testid={`text-guide-position-${orientation}-${index}`}
        >
          {Math.round(value)}px
        </span>
      )}
    </div>
  );
}

export default function CanvasGuidesOverlay({
  guides = { vertical: [], horizontal: [] },
  pending = null, // { orientation, value, removing } — live create
  moving = null,  // { orientation, index } — stored guide being dragged
  show = true,
  zoom = 1,
  canvasWidth = 0,
  stageHeight = 0,
  onGuidePointerDown, // (orientation, index, e) => void
  onToggleGuideLock,  // (orientation, index) => void
  onSetGuidePosition, // (orientation, index, pos) => void
}) {
  const widthPx = canvasWidth * zoom;
  const heightPx = stageHeight * zoom;

  const renderVertical = (guide, key, opts = {}) => {
    const { index = null, removing = false, isPending = false, locked = false, hideChip = false } = opts;
    const value = typeof guide === 'object' ? guide.pos : guide;
    const left = value * zoom;
    const lineColor = removing ? REMOVE_COLOR : (locked ? LOCKED_COLOR : GUIDE_COLOR);
    return (
      <div key={key}>
        <div
          className="absolute"
          style={{ left, top: 0, width: 1, height: heightPx, background: lineColor, opacity: removing ? 0.9 : 0.85 }}
        />
        {index != null && (
          <div
            className="absolute pointer-events-auto"
            style={{ left: left - GRAB / 2, top: 0, width: GRAB, height: heightPx, cursor: locked ? 'not-allowed' : 'col-resize' }}
            onPointerDown={(e) => { if (!locked) onGuidePointerDown?.('vertical', index, e); }}
            data-testid={`guide-vertical-${index}`}
            data-guide-value={value}
            data-guide-locked={locked ? 'true' : 'false'}
          />
        )}
        {index != null && !hideChip && (
          <GuideChip
            orientation="vertical"
            index={index}
            value={value}
            locked={locked}
            left={left}
            onToggleLock={onToggleGuideLock}
            onSetPosition={onSetGuidePosition}
          />
        )}
        {(isPending || (moving && moving.orientation === 'vertical' && moving.index === index)) && (
          <Readout orientation="vertical" value={value} left={left} removing={removing} />
        )}
      </div>
    );
  };

  const renderHorizontal = (guide, key, opts = {}) => {
    const { index = null, removing = false, isPending = false, locked = false, hideChip = false } = opts;
    const value = typeof guide === 'object' ? guide.pos : guide;
    const top = value * zoom;
    const lineColor = removing ? REMOVE_COLOR : (locked ? LOCKED_COLOR : GUIDE_COLOR);
    return (
      <div key={key}>
        <div
          className="absolute"
          style={{ top, left: 0, height: 1, width: widthPx, background: lineColor, opacity: removing ? 0.9 : 0.85 }}
        />
        {index != null && (
          <div
            className="absolute pointer-events-auto"
            style={{ top: top - GRAB / 2, left: 0, height: GRAB, width: widthPx, cursor: locked ? 'not-allowed' : 'row-resize' }}
            onPointerDown={(e) => { if (!locked) onGuidePointerDown?.('horizontal', index, e); }}
            data-testid={`guide-horizontal-${index}`}
            data-guide-value={value}
            data-guide-locked={locked ? 'true' : 'false'}
          />
        )}
        {index != null && !hideChip && (
          <GuideChip
            orientation="horizontal"
            index={index}
            value={value}
            locked={locked}
            top={top}
            onToggleLock={onToggleGuideLock}
            onSetPosition={onSetGuidePosition}
          />
        )}
        {(isPending || (moving && moving.orientation === 'horizontal' && moving.index === index)) && (
          <Readout orientation="horizontal" value={value} top={top} removing={removing} />
        )}
      </div>
    );
  };

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ width: widthPx, height: heightPx, zIndex: 40 }}
      data-testid="canvas-guides-overlay"
    >
      {show && guides.vertical.map((g, i) => {
        // While a stored guide is being moved, draw it at its live value below.
        if (moving && moving.orientation === 'vertical' && moving.index === i) return null;
        return renderVertical(g, `v-${i}`, { index: i, locked: !!g.locked });
      })}
      {show && guides.horizontal.map((g, i) => {
        if (moving && moving.orientation === 'horizontal' && moving.index === i) return null;
        return renderHorizontal(g, `h-${i}`, { index: i, locked: !!g.locked });
      })}

      {/* Live guide being moved (its stored line is hidden above). */}
      {show && moving && pending && (
        moving.orientation === 'vertical'
          ? renderVertical(pending.value, 'moving', { index: moving.index, removing: pending.removing, hideChip: true })
          : renderHorizontal(pending.value, 'moving', { index: moving.index, removing: pending.removing, hideChip: true })
      )}

      {/* Live guide being created from a ruler. */}
      {pending && !moving && (
        pending.orientation === 'vertical'
          ? renderVertical(pending.value, 'pending', { isPending: true, removing: pending.removing })
          : renderHorizontal(pending.value, 'pending', { isPending: true, removing: pending.removing })
      )}
    </div>
  );
}

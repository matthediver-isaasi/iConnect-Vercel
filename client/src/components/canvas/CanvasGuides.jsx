// Task #1665: editor-only ruler guides overlay.
//
// Rendered OUTSIDE the zoom-scaled stage (positioned over it in screen pixels),
// so guide lines stay crisp 1px and the coordinate readout keeps a natural font
// size at any zoom. Stage coordinates are converted to screen pixels by
// multiplying by `zoom`. The container is click-through (`pointer-events-none`);
// only the grab strips opt back in so clicks elsewhere reach the blocks below.

const GUIDE_COLOR = '#06b6d4'; // cyan — distinct from the pink sibling-snap highlight
const REMOVE_COLOR = '#ef4444'; // red — shown when a drag would remove the guide
const GRAB = 9; // screen-px width of the transparent grab strip

function Readout({ orientation, value, left, top, removing }) {
  const style = orientation === 'vertical'
    ? { left, top: 2 }
    : { left: 2, top };
  return (
    <div
      className="absolute rounded-sm px-1 py-0.5 text-[10px] font-semibold text-white tabular-nums whitespace-nowrap"
      style={{ ...style, background: removing ? REMOVE_COLOR : GUIDE_COLOR, transform: orientation === 'vertical' ? 'translateX(3px)' : 'translateY(3px)' }}
      data-testid="guide-readout"
    >
      {removing ? 'Release to remove' : `${Math.round(value)}px`}
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
}) {
  const widthPx = canvasWidth * zoom;
  const heightPx = stageHeight * zoom;

  const renderVertical = (value, key, opts = {}) => {
    const { index = null, removing = false, isPending = false } = opts;
    const left = value * zoom;
    return (
      <div key={key}>
        <div
          className="absolute"
          style={{ left, top: 0, width: 1, height: heightPx, background: removing ? REMOVE_COLOR : GUIDE_COLOR, opacity: removing ? 0.9 : 0.85 }}
        />
        {index != null && (
          <div
            className="absolute pointer-events-auto"
            style={{ left: left - GRAB / 2, top: 0, width: GRAB, height: heightPx, cursor: 'col-resize' }}
            onPointerDown={(e) => onGuidePointerDown?.('vertical', index, e)}
            data-testid={`guide-vertical-${index}`}
            data-guide-value={value}
          />
        )}
        {(isPending || (moving && moving.orientation === 'vertical' && moving.index === index)) && (
          <Readout orientation="vertical" value={value} left={left} removing={removing} />
        )}
      </div>
    );
  };

  const renderHorizontal = (value, key, opts = {}) => {
    const { index = null, removing = false, isPending = false } = opts;
    const top = value * zoom;
    return (
      <div key={key}>
        <div
          className="absolute"
          style={{ top, left: 0, height: 1, width: widthPx, background: removing ? REMOVE_COLOR : GUIDE_COLOR, opacity: removing ? 0.9 : 0.85 }}
        />
        {index != null && (
          <div
            className="absolute pointer-events-auto"
            style={{ top: top - GRAB / 2, left: 0, height: GRAB, width: widthPx, cursor: 'row-resize' }}
            onPointerDown={(e) => onGuidePointerDown?.('horizontal', index, e)}
            data-testid={`guide-horizontal-${index}`}
            data-guide-value={value}
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
      {show && guides.vertical.map((v, i) => {
        // While a stored guide is being moved, draw it at its live value below.
        if (moving && moving.orientation === 'vertical' && moving.index === i) return null;
        return renderVertical(v, `v-${i}`, { index: i });
      })}
      {show && guides.horizontal.map((v, i) => {
        if (moving && moving.orientation === 'horizontal' && moving.index === i) return null;
        return renderHorizontal(v, `h-${i}`, { index: i });
      })}

      {/* Live guide being moved (its stored line is hidden above). */}
      {show && moving && pending && (
        moving.orientation === 'vertical'
          ? renderVertical(pending.value, 'moving', { index: moving.index, removing: pending.removing })
          : renderHorizontal(pending.value, 'moving', { index: moving.index, removing: pending.removing })
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

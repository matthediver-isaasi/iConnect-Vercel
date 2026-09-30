const GAP = 4;
const EDGE = 8;

function localViewport(win) {
  const visual = win.visualViewport;
  const left = visual?.offsetLeft || 0;
  const top = visual?.offsetTop || 0;
  return {
    left, top,
    right: Math.min(win.innerWidth, left + (visual?.width || win.innerWidth)),
    bottom: Math.min(win.innerHeight, top + (visual?.height || win.innerHeight)),
  };
}

function sized(rect) {
  return { ...rect, width: Math.max(0, rect.right - rect.left), height: Math.max(0, rect.bottom - rect.top) };
}

// All coordinates are in the trigger's document. A same-origin Canvas frame
// can be much taller than the visible browser viewport. Never use that full
// height as available menu space. Cross-origin hosts remain iframe-local.
export function readFormPickerViewport(win = window) {
  const local = localViewport(win);
  let frame;
  try { frame = win.frameElement; } catch { /* cross-origin host */ }
  if (!frame) return sized(local);
  const parent = frame.ownerDocument.defaultView;
  const outer = readFormPickerViewport(parent);
  const rect = frame.getBoundingClientRect();
  const sx = frame.offsetWidth ? rect.width / frame.offsetWidth : 1;
  const sy = frame.offsetHeight ? rect.height / frame.offsetHeight : 1;
  if (!sx || !sy) return sized(local);
  const x = rect.left + frame.clientLeft * sx;
  const y = rect.top + frame.clientTop * sy;
  return sized({
    left: Math.max(local.left, (outer.left - x) / sx),
    top: Math.max(local.top, (outer.top - y) / sy),
    right: Math.min(local.right, (outer.right - x) / sx),
    bottom: Math.min(local.bottom, (outer.bottom - y) / sy),
  });
}

export function getFormPickerPlacement(trigger, viewport, { searchable = false } = {}) {
  const below = Math.max(0, viewport.bottom - EDGE - trigger.bottom - GAP);
  const above = Math.max(0, trigger.top - viewport.top - EDGE - GAP);
  const minimum = searchable ? 180 : 120;
  // Prefer below when it can show a useful list, rather than flipping merely
  // because a long list has more total content than will ever fit.
  const side = below >= minimum || below >= above ? 'bottom' : 'top';
  return {
    side,
    maxHeight: Math.min(384, side === 'bottom' ? below : above),
    dialog: Math.max(below, above) < minimum,
  };
}

export function formPickerCollisionPadding(viewport, win = window) {
  const local = localViewport(win);
  return {
    top: Math.max(0, viewport.top - local.top) + EDGE,
    bottom: Math.max(0, local.bottom - viewport.bottom) + EDGE,
    left: Math.max(0, viewport.left - local.left) + EDGE,
    right: Math.max(0, local.right - viewport.right) + EDGE,
  };
}

export function formPickerDialogStyle(viewport) {
  return {
    position: 'fixed',
    left: viewport.left + EDGE,
    top: viewport.top + EDGE,
    width: Math.max(0, viewport.width - EDGE * 2),
    maxHeight: Math.max(0, viewport.height - EDGE * 2),
    transform: 'none',
  };
}

// Only an open picker owns these listeners. Capture-phase scroll includes
// nested host scrollers; the animation frame also catches layout/reflow that
// moves the iframe without producing a scroll or window resize event.
export function subscribeFormPickerViewport(trigger, callback) {
  const win = trigger.ownerDocument.defaultView;
  const targets = new Set();
  let current = win;
  while (current) {
    targets.add(current);
    if (current.visualViewport) targets.add(current.visualViewport);
    let frame;
    try { frame = current.frameElement; } catch { /* cross-origin */ }
    current = frame?.ownerDocument.defaultView;
  }
  let disposed = false;
  let frameId;
  let previous = '';
  const update = () => {
    if (disposed) return;
    const viewport = readFormPickerViewport(win);
    const rect = trigger.getBoundingClientRect();
    const key = JSON.stringify([viewport, rect.top, rect.right, rect.bottom, rect.left]);
    if (key !== previous) {
      previous = key;
      callback(viewport, rect);
    }
  };
  const tick = () => {
    update();
    if (!disposed) frameId = win.requestAnimationFrame(tick);
  };
  for (const target of targets) {
    target.addEventListener('scroll', update, true);
    target.addEventListener('resize', update);
  }
  tick();
  return () => {
    disposed = true;
    win.cancelAnimationFrame(frameId);
    for (const target of targets) {
      target.removeEventListener('scroll', update, true);
      target.removeEventListener('resize', update);
    }
  };
}
// Read-time font identity, not a global font gate. FontFaceSet.ready can resolve
// before an async tenant stylesheet has even registered its faces.
export function readReflowFontKey(element) {
  const styles = new Set();
  const families = new Set();
  for (const node of [element, ...element.querySelectorAll('*')]) {
    // Expanded answers must not change the identity of a collapsed accordion.
    if (node.closest('[data-reflow-expansion]')) continue;
    if (node !== element && ![...node.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const css = getComputedStyle(node);
    styles.add([css.fontFamily, css.fontSize, css.fontWeight, css.fontStyle,
      css.lineHeight, css.letterSpacing, css.marginTop, css.marginBottom].join('|'));
    css.fontFamily.split(',').forEach(f => families.add(f.trim().replace(/['"]/g, '').toLowerCase()));
  }
  const faces = [];
  document.fonts?.forEach(face => {
    if (families.has(face.family.replace(/['"]/g, '').toLowerCase())) {
      faces.push([face.family, face.weight, face.style, face.unicodeRange, face.status].join('|'));
    }
  });
  return JSON.stringify([Math.round(element.getBoundingClientRect().width), [...styles].sort(), faces.sort()]);
}

// One shared subscription regardless of block count. No loading UI, timeout,
// polling or perpetual animation loop. Late success/error remains observable.
const subscribers = new Set();
let dispose;
export function subscribeReflowFontMetrics(report) {
  subscribers.add(report);
  if (!dispose) {
    let frame;
    let secondFrame;
    const notify = () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(secondFrame);
      frame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => subscribers.forEach(callback => callback()));
      });
    };
    const onAsset = event => {
      if (event.target?.matches?.('link[rel="stylesheet"]')) notify();
    };
    document.fonts?.addEventListener('loadingdone', notify);
    document.fonts?.addEventListener('loadingerror', notify);
    document.addEventListener('load', onAsset, true);
    document.addEventListener('error', onAsset, true);
    dispose = () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(secondFrame);
      document.fonts?.removeEventListener('loadingdone', notify);
      document.fonts?.removeEventListener('loadingerror', notify);
      document.removeEventListener('load', onAsset, true);
      document.removeEventListener('error', onAsset, true);
    };
  }
  return () => {
    subscribers.delete(report);
    if (!subscribers.size) {
      dispose();
      dispose = undefined;
    }
  };
}

export function measureCollapsedReflowHeight(element, height, zoom = 1) {
  const panels = [...element.querySelectorAll('[data-reflow-expansion]')]
    .filter(panel => !panel.parentElement?.closest('[data-reflow-expansion]'));
  if (!panels.length) return undefined;
  return Math.max(0, height - panels.reduce((sum, panel) => sum + panel.getBoundingClientRect().height / zoom, 0));
}

// A margin change does not resize a border box. Observe the measured subtree's
// styles as well as its size, batching mutations so typography reconciliation
// cannot leave an old margin-inclusive footprint behind.
export function observeReflowStyleChanges(element, report) {
  let frame;
  const observer = new MutationObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(report);
  });
  observer.observe(element, {
    subtree: true, attributes: true, attributeFilter: ['style', 'class'],
    childList: true,
  });
  return () => { observer.disconnect(); cancelAnimationFrame(frame); };
}

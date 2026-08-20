/**
 * Let a published Canvas form block follow its iframe's reported height.
 *
 * Canvas v1 blocks are absolutely positioned, so growing the form also moves
 * siblings that start below its authored bottom. The returned cleanup restores
 * every inline style, allowing a later resize report (including a shrink) to
 * recompute from the original authored geometry.
 */
export function applyFormEmbedResize(blockEl) {
  if (!blockEl) return () => {};

  const stageEl = blockEl.closest('.canvas-stage');
  const originalHeight = blockEl.offsetHeight;
  const originalBottom = blockEl.offsetTop + originalHeight;

  const prevHeight = blockEl.style.height;
  const prevOverflow = blockEl.style.overflow;
  blockEl.style.height = 'auto';
  blockEl.style.overflow = 'visible';

  const delta = blockEl.offsetHeight - originalHeight;
  const movedTops = [];

  if (stageEl && delta > 0) {
    stageEl.querySelectorAll('[data-cb]').forEach((el) => {
      if (el === blockEl || blockEl.contains(el)) return;
      if (el.offsetTop >= originalBottom - 1) {
        movedTops.push([el, el.style.top]);
        el.style.top = `${el.offsetTop + delta}px`;
      }
    });
  }

  let prevStageMinHeight;
  if (stageEl) {
    prevStageMinHeight = stageEl.style.minHeight;
    let maxBottom = blockEl.offsetTop + blockEl.offsetHeight;
    stageEl.querySelectorAll('[data-cb]').forEach((el) => {
      if (el === blockEl || blockEl.contains(el)) return;
      const bottom = el.offsetTop + el.offsetHeight;
      if (bottom > maxBottom) maxBottom = bottom;
    });
    // Published pages end at the actual lowest rendered block. The editor's
    // separate 80px drag buffer is intentionally not used here.
    stageEl.style.minHeight = `${Math.ceil(maxBottom)}px`;
  }

  return () => {
    blockEl.style.height = prevHeight;
    blockEl.style.overflow = prevOverflow;
    if (stageEl) stageEl.style.minHeight = prevStageMinHeight;
    movedTops.forEach(([el, prev]) => { el.style.top = prev; });
  };
}
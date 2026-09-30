const stageResizeStates = new WeakMap();

function captureElement(element) {
  return {
    element,
    top: element.style.top,
    appliedTop: null,
    ownsFormStyles: false,
    height: null,
    overflow: null,
    appliedHeight: null,
    appliedOverflow: null,
    authoredTop: 0,
    authoredHeight: 0,
  };
}

function restoreAuthoredStyles(state) {
  if (state.appliedMinHeight != null) {
    if (state.stage.style.minHeight === state.appliedMinHeight) {
      state.stage.style.minHeight = state.minHeight;
    } else {
      state.minHeight = state.stage.style.minHeight;
    }
    state.appliedMinHeight = null;
  } else {
    state.minHeight = state.stage.style.minHeight;
  }

  state.elements.forEach((entry) => {
    if (entry.appliedTop != null) {
      if (entry.element.style.top === entry.appliedTop) {
        entry.element.style.top = entry.top;
      } else {
        // React or another Canvas reflow owner changed this inline position
        // after our pass. Adopt it instead of restoring stale geometry.
        entry.top = entry.element.style.top;
      }
      entry.appliedTop = null;
    } else {
      entry.top = entry.element.style.top;
    }

    if (!entry.ownsFormStyles) return;
    if (entry.appliedHeight != null) {
      if (entry.element.style.height === entry.appliedHeight) {
        entry.element.style.height = entry.height;
      } else {
        entry.height = entry.element.style.height;
      }
      entry.appliedHeight = null;
    } else {
      entry.height = entry.element.style.height;
    }
    if (entry.appliedOverflow != null) {
      if (entry.element.style.overflow === entry.appliedOverflow) {
        entry.element.style.overflow = entry.overflow;
      } else {
        entry.overflow = entry.element.style.overflow;
      }
      entry.appliedOverflow = null;
    } else {
      entry.overflow = entry.element.style.overflow;
    }
  });
}

function recomputeStage(state) {
  restoreAuthoredStyles(state);

  // Re-read geometry after restoring the authored inline styles. Apart from
  // avoiding cumulative resize deltas, this lets CSS breakpoint rules supply
  // fresh positions and heights when a resize report follows a viewport change.
  state.stage.querySelectorAll('[data-cb]').forEach((element) => {
    if (!state.elements.has(element)) {
      state.elements.set(element, captureElement(element));
    }
  });
  state.elements.forEach((entry, element) => {
    if (element.closest('.canvas-stage') !== state.stage) {
      state.elements.delete(element);
      return;
    }
    entry.authoredTop = element.offsetTop;
    entry.authoredHeight = element.offsetHeight;
  });

  const activeForms = [];
  const measuredBlocks = new Set();
  state.registrations.forEach(({ block }) => {
    const entry = state.elements.get(block);
    if (!entry || measuredBlocks.has(block) || block.closest('.canvas-stage') !== state.stage) return;
    measuredBlocks.add(block);
    if (!entry.ownsFormStyles) {
      entry.ownsFormStyles = true;
      entry.height = block.style.height;
      entry.overflow = block.style.overflow;
    }
    block.style.height = 'auto';
    block.style.overflow = 'visible';
    entry.appliedHeight = 'auto';
    entry.appliedOverflow = 'visible';
    activeForms.push({
      block,
      bottom: entry.authoredTop + entry.authoredHeight,
      growth: Math.max(0, block.offsetHeight - entry.authoredHeight),
    });
  });

  state.elements.forEach((entry, element) => {
    const push = activeForms.reduce((total, form) => {
      if (form.growth <= 0 || element === form.block || form.block.contains(element)) {
        return total;
      }
      return entry.authoredTop >= form.bottom - 1 ? total + form.growth : total;
    }, 0);
    if (push > 0) {
      entry.appliedTop = `${entry.authoredTop + push}px`;
      element.style.top = entry.appliedTop;
    }
  });

  let maxBottom = 0;
  state.elements.forEach((entry, element) => {
    const bottom = element.offsetTop + element.offsetHeight;
    if (bottom > maxBottom) maxBottom = bottom;
  });
  // Published pages end at the actual lowest rendered block. The editor's
  // separate 80px drag buffer is intentionally not used here.
  state.appliedMinHeight = `${Math.ceil(maxBottom)}px`;
  state.stage.style.minHeight = state.appliedMinHeight;
}

/**
 * Let a published Canvas form block follow its iframe's reported height.
 *
 * Resize ownership is coordinated per stage. Each change first restores every
 * block to authored geometry, then reapplies all active form growth in document
 * order. This prevents one form's effect cleanup from restoring stale styles
 * captured after another form had already moved the same siblings.
 */
export function applyFormEmbedResize(blockEl) {
  if (!blockEl) return () => {};

  const stageEl = blockEl.closest('.canvas-stage');
  if (!stageEl) {
    const height = blockEl.style.height;
    const overflow = blockEl.style.overflow;
    blockEl.style.height = 'auto';
    blockEl.style.overflow = 'visible';
    let cleanedUp = false;
    return () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (blockEl.style.height === 'auto') blockEl.style.height = height;
      if (blockEl.style.overflow === 'visible') blockEl.style.overflow = overflow;
    };
  }

  let state = stageResizeStates.get(stageEl);
  if (!state) {
    state = {
      stage: stageEl,
      minHeight: stageEl.style.minHeight,
      appliedMinHeight: null,
      elements: new Map(),
      registrations: new Map(),
    };
    stageEl.querySelectorAll('[data-cb]').forEach((element) => {
      state.elements.set(element, captureElement(element));
    });
    stageResizeStates.set(stageEl, state);
  }

  const registration = {};
  state.registrations.set(registration, { block: blockEl });
  recomputeStage(state);

  let cleanedUp = false;
  return () => {
    if (cleanedUp) return;
    cleanedUp = true;
    state.registrations.delete(registration);
    if (state.registrations.size > 0) {
      recomputeStage(state);
      return;
    }
    restoreAuthoredStyles(state);
    stageResizeStates.delete(stageEl);
  };
}
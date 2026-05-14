// Canvas Builder design document helpers.
//
// The canvas_design column on i_edit_page stores a versioned JSON document
// describing a free-form page laid out by the Canvas Builder. Phase 1 only
// defines the shape and provides empty-state helpers; no block types are
// wired up yet.

export const CANVAS_DESIGN_VERSION = 1;

export function createEmptyCanvasDesign() {
  return {
    version: CANVAS_DESIGN_VERSION,
    root: {
      background: null,
      sections: [],
    },
  };
}

export function normalizeCanvasDesign(design) {
  if (!design || typeof design !== 'object') return createEmptyCanvasDesign();
  const root = design.root && typeof design.root === 'object' ? design.root : {};
  return {
    version: typeof design.version === 'number' ? design.version : CANVAS_DESIGN_VERSION,
    root: {
      background: root.background ?? null,
      sections: Array.isArray(root.sections) ? root.sections : [],
    },
  };
}

// Walk every child block in a design document. Stable iteration order:
// sections in array order, then children in array order within each section.
export function forEachBlock(design, fn) {
  const d = normalizeCanvasDesign(design);
  for (const section of d.root.sections) {
    if (!section || !Array.isArray(section.children)) continue;
    for (const child of section.children) {
      if (child && typeof child === 'object') fn(child, section);
    }
  }
}

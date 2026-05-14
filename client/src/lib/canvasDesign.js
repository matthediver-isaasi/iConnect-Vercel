// Canvas Builder design document helpers.
//
// The canvas_design column on i_edit_page stores a versioned JSON document
// describing a free-form page laid out by the Canvas Builder.
//
// Phase 2 schema:
//   {
//     version: 1,
//     root: {
//       background: null | { color },
//       sections: [{
//         id: 'root-section',
//         children: [
//           {
//             id, type: 'box', name, locked, style: {...}, a11y: {...},
//             bp: {
//               desktop: { x, y, w, h, hidden? },     // always complete
//               tablet:  { x?, y?, w?, h?, hidden? }, // partial overrides
//               mobile:  { x?, y?, w?, h?, hidden? },
//             },
//           },
//         ],
//       }],
//     },
//   }
//
// Tablet/mobile inherit any unset field from the next-larger breakpoint
// (mobile -> tablet -> desktop).

export const CANVAS_DESIGN_VERSION = 1;

export const BREAKPOINTS = ['desktop', 'tablet', 'mobile'];

export const BREAKPOINT_WIDTHS = {
  desktop: 1200,
  tablet: 768,
  mobile: 375,
};

export const BLOCK_TYPES = {
  BOX: 'box',
};

const DEFAULT_STYLE = {
  background: '#ffffff',
  borderColor: '#cbd5e1',
  borderWidth: 1,
  borderStyle: 'solid',
  borderRadius: 4,
  opacity: 1,
  zIndex: 1,
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
};

const DEFAULT_A11Y = {
  role: '',
  ariaLabel: '',
  tabIndex: null, // null = not focusable beyond default
  ariaHidden: false,
  altText: '', // forward-compat for image-bearing blocks in Phase 3
};

export function createEmptyCanvasDesign() {
  return {
    version: CANVAS_DESIGN_VERSION,
    root: {
      background: null,
      sections: [
        {
          id: 'root-section',
          children: [],
        },
      ],
    },
  };
}

function generateId(prefix = 'block') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createBlock(type = BLOCK_TYPES.BOX, overrides = {}) {
  const desktop = {
    x: 40,
    y: 40,
    w: 200,
    h: 120,
    hidden: false,
    ...(overrides.desktop || {}),
  };
  return {
    id: overrides.id || generateId(),
    type,
    name: overrides.name || 'Box',
    locked: false,
    style: { ...DEFAULT_STYLE, ...(overrides.style || {}) },
    a11y: { ...DEFAULT_A11Y, ...(overrides.a11y || {}) },
    bp: {
      desktop,
      tablet: overrides.tablet || {},
      mobile: overrides.mobile || {},
    },
  };
}

export function normalizeCanvasDesign(design) {
  if (!design || typeof design !== 'object') return createEmptyCanvasDesign();
  const root = design.root && typeof design.root === 'object' ? design.root : {};
  const sections = Array.isArray(root.sections) && root.sections.length > 0
    ? root.sections.map(normalizeSection)
    : [{ id: 'root-section', children: [] }];
  return {
    version: typeof design.version === 'number' ? design.version : CANVAS_DESIGN_VERSION,
    root: {
      background: root.background ?? null,
      sections,
    },
  };
}

function normalizeSection(section) {
  if (!section || typeof section !== 'object') {
    return { id: 'root-section', children: [] };
  }
  const children = Array.isArray(section.children)
    ? section.children.map(normalizeBlock).filter(Boolean)
    : [];
  return {
    id: section.id || 'root-section',
    children,
  };
}

function normalizeBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const bp = block.bp && typeof block.bp === 'object' ? block.bp : {};
  const desktop = {
    x: 40, y: 40, w: 200, h: 120, hidden: false,
    ...(bp.desktop && typeof bp.desktop === 'object' ? bp.desktop : {}),
  };
  return {
    id: block.id || generateId(),
    type: block.type || BLOCK_TYPES.BOX,
    name: block.name || 'Box',
    locked: !!block.locked,
    style: { ...DEFAULT_STYLE, ...(block.style || {}) },
    a11y: { ...DEFAULT_A11Y, ...(block.a11y || {}) },
    bp: {
      desktop,
      tablet: bp.tablet && typeof bp.tablet === 'object' ? bp.tablet : {},
      mobile: bp.mobile && typeof bp.mobile === 'object' ? bp.mobile : {},
    },
  };
}

// Resolve geometry/visibility for a block at a given breakpoint by
// cascading mobile -> tablet -> desktop. Returns { x, y, w, h, hidden }.
export function resolveBlockAtBreakpoint(block, breakpoint) {
  const d = block.bp?.desktop || {};
  const t = block.bp?.tablet || {};
  const m = block.bp?.mobile || {};
  const base = { x: 40, y: 40, w: 200, h: 120, hidden: false, ...d };
  if (breakpoint === 'desktop') return base;
  const withTablet = { ...base, ...stripUndefined(t) };
  if (breakpoint === 'tablet') return withTablet;
  return { ...withTablet, ...stripUndefined(m) };
}

function stripUndefined(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  }
  return out;
}

// Returns true if the breakpoint has its own override for the given field.
export function hasOverride(block, breakpoint, field) {
  if (breakpoint === 'desktop') return true;
  const bp = block.bp?.[breakpoint] || {};
  return Object.prototype.hasOwnProperty.call(bp, field) && bp[field] !== undefined && bp[field] !== null;
}

// Immutably set a geometry field on the appropriate breakpoint layer.
// Editing on desktop writes to desktop (always populated); editing on
// tablet/mobile only writes the override. Pass undefined to clear an
// override (only legal on tablet/mobile).
export function setBlockBp(block, breakpoint, patch) {
  const next = { ...block, bp: { ...block.bp } };
  next.bp[breakpoint] = { ...(block.bp?.[breakpoint] || {}), ...patch };
  return next;
}

export function clearBpOverride(block, breakpoint, field) {
  if (breakpoint === 'desktop') return block;
  const layer = { ...(block.bp?.[breakpoint] || {}) };
  delete layer[field];
  return { ...block, bp: { ...block.bp, [breakpoint]: layer } };
}

// Walk every child block in a design document.
export function forEachBlock(design, fn) {
  const d = normalizeCanvasDesign(design);
  for (const section of d.root.sections) {
    if (!section || !Array.isArray(section.children)) continue;
    for (const child of section.children) {
      if (child && typeof child === 'object') fn(child, section);
    }
  }
}

export function mapBlocks(design, fn) {
  const d = normalizeCanvasDesign(design);
  return {
    ...d,
    root: {
      ...d.root,
      sections: d.root.sections.map((s) => ({
        ...s,
        children: s.children.map((c) => fn(c) || c),
      })),
    },
  };
}

export function getRootChildren(design) {
  const d = normalizeCanvasDesign(design);
  return d.root.sections[0]?.children || [];
}

export function setRootChildren(design, children) {
  const d = normalizeCanvasDesign(design);
  return {
    ...d,
    root: {
      ...d.root,
      sections: [{ ...d.root.sections[0], id: d.root.sections[0]?.id || 'root-section', children }],
    },
  };
}

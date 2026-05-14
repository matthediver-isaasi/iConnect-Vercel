// Canvas Builder design document helpers.
//
// The canvas_design column on i_edit_page stores a versioned JSON document
// describing a free-form page laid out by the Canvas Builder.
//
// Phase 3 schema (back-compat with Phase 2 'box' blocks):
//   {
//     version: 1,
//     root: {
//       background: null | { color },
//       sections: [{
//         id: 'root-section',
//         children: [
//           {
//             id, type: 'box'|'hero'|'text'|... , name, locked,
//             style: {...},        // visual style (bg/border/etc.)
//             a11y: {...},         // role / aria-label / alt / tabIndex
//             content: {...},      // block-type-specific content (Phase 3+)
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

// Static block types shipped in Phase 3.
export const BLOCK_TYPES = {
  BOX: 'box',
  SECTION: 'section',
  HERO: 'hero',
  TEXT: 'text',
  IMAGE: 'image',
  BUTTON: 'button',
  VIDEO: 'video',
  COLUMNS: 'columns',
  SPACER: 'spacer',
  DIVIDER: 'divider',
  ACCORDION: 'accordion',
  TESTIMONIALS: 'testimonials',
  CUSTOM_HTML: 'custom-html',
  ICON: 'icon',
  CARD: 'card',
  STAT: 'stat',
  LOGO_STRIP: 'logo-strip',
  MAP: 'map',
};

const DEFAULT_STYLE = {
  background: 'transparent',
  borderColor: '#cbd5e1',
  borderWidth: 0,
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
  altText: '',
};

// Defaults per block type (geometry + content + style overrides + a11y).
// The block registry under client/src/components/canvas/blocks/registry.jsx
// is the editor/renderer source-of-truth; this is the data-layer copy used
// by createBlock/normalizeBlock so the lib can stay React-free.
export const BLOCK_DEFAULTS = {
  [BLOCK_TYPES.BOX]: {
    name: 'Box',
    geom: { w: 200, h: 120 },
    style: { background: '#ffffff', borderWidth: 1 },
    content: {},
  },
  [BLOCK_TYPES.SECTION]: {
    name: 'Section',
    geom: { w: 600, h: 240 },
    style: { background: '#f8fafc', borderWidth: 0, paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24 },
    content: { maxWidth: 0, fullBleed: false },
  },
  [BLOCK_TYPES.HERO]: {
    name: 'Hero',
    geom: { w: 800, h: 420 },
    style: { background: '#0f172a', borderWidth: 0, borderRadius: 0 },
    a11y: {},
    content: {
      headline: 'Your headline here',
      headingLevel: 1,
      subheadline: 'A short supporting message that frames the page.',
      bgType: 'color', // 'color' | 'image' | 'video'
      bgColor: '#0f172a',
      bgImageUrl: '',
      bgVideoUrl: '',
      darkWash: 0.4,
      alignment: 'center', // left | center | right
      textColor: '#ffffff',
      ctas: [
        { label: 'Primary CTA', href: '#', variant: 'primary' },
      ],
    },
  },
  [BLOCK_TYPES.TEXT]: {
    name: 'Text',
    geom: { w: 480, h: 160 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      html: '<p>Click to edit this text.</p>',
      colorRole: 'default', // default | secondary | tertiary
    },
  },
  [BLOCK_TYPES.IMAGE]: {
    name: 'Image',
    geom: { w: 320, h: 200 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      src: '',
      alt: '',
      href: '',
      objectFit: 'cover', // cover | contain | fill | none | scale-down
    },
  },
  [BLOCK_TYPES.BUTTON]: {
    name: 'Button',
    geom: { w: 180, h: 44 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      label: 'Click me',
      href: '#',
      variant: 'default', // default | outline | ghost | primary
      size: 'default',     // sm | default | lg
      icon: '',            // lucide name
      ariaLabel: '',
      newTab: false,
    },
  },
  [BLOCK_TYPES.VIDEO]: {
    name: 'Video',
    geom: { w: 560, h: 315 },
    style: { background: '#000000', borderWidth: 0 },
    content: {
      provider: 'youtube', // youtube | vimeo | mp4
      url: '',
      aspectRatio: '16:9',
      captionsUrl: '',
      autoplay: false,
      muted: true,
      controls: true,
    },
  },
  [BLOCK_TYPES.COLUMNS]: {
    name: 'Columns',
    geom: { w: 720, h: 240 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      count: 2,
      gap: 16,
      stackOnMobile: true,
      // widths per breakpoint as arrays summing to ~100%
      widths: { desktop: [50, 50], tablet: [50, 50], mobile: [100, 100] },
      items: [
        { html: '<p>Column 1</p>' },
        { html: '<p>Column 2</p>' },
      ],
    },
  },
  [BLOCK_TYPES.SPACER]: {
    name: 'Spacer',
    geom: { w: 400, h: 48 },
    style: { background: 'transparent', borderWidth: 0 },
    // Spacer height is driven entirely by the block's per-breakpoint
    // geometry (Position panel) — no duplicate content fields.
    content: {},
  },
  [BLOCK_TYPES.DIVIDER]: {
    name: 'Divider',
    geom: { w: 400, h: 24 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      lineStyle: 'solid', // solid | dashed | dotted
      color: '#e2e8f0',
      thickness: 1,
    },
  },
  [BLOCK_TYPES.ACCORDION]: {
    name: 'FAQ / Accordion',
    geom: { w: 560, h: 280 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      items: [
        { q: 'Question one?', a: '<p>Answer one.</p>' },
        { q: 'Question two?', a: '<p>Answer two.</p>' },
      ],
      expandOne: true,
    },
  },
  [BLOCK_TYPES.TESTIMONIALS]: {
    name: 'Testimonials',
    geom: { w: 720, h: 280 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      layout: 'grid', // single | carousel | grid
      items: [
        { quote: 'A glowing review of your work.', author: 'Jane Smith', role: 'Customer', photo: '' },
      ],
    },
  },
  [BLOCK_TYPES.CUSTOM_HTML]: {
    name: 'Custom HTML',
    geom: { w: 480, h: 200 },
    style: { background: 'transparent', borderWidth: 1, borderColor: '#facc15' },
    content: {
      html: '<div>Custom HTML — use at your own risk.</div>',
    },
  },
  [BLOCK_TYPES.ICON]: {
    name: 'Icon',
    geom: { w: 64, h: 64 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      icon: 'Star',
      color: '#0f172a',
      size: 48,
      ariaLabel: '',
    },
  },
  [BLOCK_TYPES.CARD]: {
    name: 'Card',
    geom: { w: 320, h: 380 },
    style: { background: '#ffffff', borderWidth: 1, borderRadius: 8, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16 },
    content: {
      imageUrl: '',
      imageAlt: '',
      heading: 'Card heading',
      headingLevel: 3,
      body: '<p>A short description for this card.</p>',
      ctaLabel: 'Learn more',
      ctaHref: '#',
      ctaVariant: 'outline',
    },
  },
  [BLOCK_TYPES.STAT]: {
    name: 'Stat',
    geom: { w: 240, h: 140 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      value: '1,200+',
      label: 'Happy members',
      color: '',
    },
  },
  [BLOCK_TYPES.LOGO_STRIP]: {
    name: 'Logo strip',
    geom: { w: 720, h: 100 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      logos: [
        { src: '', alt: '', href: '' },
        { src: '', alt: '', href: '' },
        { src: '', alt: '', href: '' },
      ],
      gap: 32,
      grayscale: true,
    },
  },
  [BLOCK_TYPES.MAP]: {
    name: 'Map',
    geom: { w: 480, h: 320 },
    style: { background: '#e2e8f0', borderWidth: 0, borderRadius: 8 },
    content: {
      query: 'London, UK',
      zoom: 12,
      title: 'Location',
    },
  },
};

export function getBlockDefaults(type) {
  return BLOCK_DEFAULTS[type] || BLOCK_DEFAULTS[BLOCK_TYPES.BOX];
}

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
  const defaults = getBlockDefaults(type);
  const desktop = {
    x: 40,
    y: 40,
    w: defaults.geom?.w ?? 200,
    h: defaults.geom?.h ?? 120,
    hidden: false,
    ...(overrides.desktop || {}),
  };
  return {
    id: overrides.id || generateId(),
    type,
    name: overrides.name || defaults.name || 'Block',
    locked: false,
    style: { ...DEFAULT_STYLE, ...(defaults.style || {}), ...(overrides.style || {}) },
    a11y: { ...DEFAULT_A11Y, ...(defaults.a11y || {}), ...(overrides.a11y || {}) },
    content: deepClone({ ...(defaults.content || {}), ...(overrides.content || {}) }),
    bp: {
      desktop,
      tablet: overrides.tablet || {},
      mobile: overrides.mobile || {},
    },
  };
}

function deepClone(v) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const o = {};
  for (const k of Object.keys(v)) o[k] = deepClone(v[k]);
  return o;
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
  const type = block.type || BLOCK_TYPES.BOX;
  const defaults = getBlockDefaults(type);
  const bp = block.bp && typeof block.bp === 'object' ? block.bp : {};
  const desktop = {
    x: 40, y: 40,
    w: defaults.geom?.w ?? 200, h: defaults.geom?.h ?? 120,
    hidden: false,
    ...(bp.desktop && typeof bp.desktop === 'object' ? bp.desktop : {}),
  };
  return {
    id: block.id || generateId(),
    type,
    name: block.name || defaults.name || 'Block',
    locked: !!block.locked,
    style: { ...DEFAULT_STYLE, ...(defaults.style || {}), ...(block.style || {}) },
    a11y: { ...DEFAULT_A11Y, ...(defaults.a11y || {}), ...(block.a11y || {}) },
    content: { ...(defaults.content || {}), ...(block.content || {}) },
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

// ---------------------------------------------------------------------------
// Publish-time validation
//
// Each block can report missing-required fields. The lib walks every block
// and accumulates errors so the editor can block publish with clear context.
// ---------------------------------------------------------------------------

export function validateBlock(block) {
  if (!block || typeof block !== 'object') return [];
  const errors = [];
  const c = block.content || {};
  switch (block.type) {
    case BLOCK_TYPES.HERO:
      if (!c.headline || !String(c.headline).trim()) {
        errors.push('Hero requires a headline.');
      }
      if (c.bgType === 'image' && !c.bgImageUrl) {
        errors.push('Hero background image is missing.');
      }
      if (c.bgType === 'video' && !c.bgVideoUrl) {
        errors.push('Hero background video URL is missing.');
      }
      break;
    case BLOCK_TYPES.IMAGE:
      if (!c.src) errors.push('Image source is missing.');
      if (!c.alt || !String(c.alt).trim()) {
        errors.push('Image requires alt text for accessibility.');
      }
      break;
    case BLOCK_TYPES.BUTTON:
      if (!c.label || !String(c.label).trim()) errors.push('Button requires a label.');
      if (!c.href) errors.push('Button requires a link target.');
      break;
    case BLOCK_TYPES.VIDEO:
      if (!c.url) errors.push('Video requires a URL.');
      break;
    case BLOCK_TYPES.CARD:
      if (c.imageUrl && (!c.imageAlt || !String(c.imageAlt).trim())) {
        errors.push('Card image requires alt text.');
      }
      break;
    case BLOCK_TYPES.LOGO_STRIP:
      (c.logos || []).forEach((l, i) => {
        if (l?.src && (!l.alt || !String(l.alt).trim())) {
          errors.push(`Logo #${i + 1} requires alt text.`);
        }
      });
      break;
    case BLOCK_TYPES.ICON:
      if (!c.icon) errors.push('Icon requires a name.');
      break;
    case BLOCK_TYPES.MAP:
      if (!c.query) errors.push('Map requires a location query.');
      break;
    case BLOCK_TYPES.CUSTOM_HTML:
      if (!c.html || !String(c.html).trim()) errors.push('Custom HTML block is empty.');
      break;
    default:
      break;
  }
  return errors;
}

export function validateCanvasDesign(design) {
  const d = normalizeCanvasDesign(design);
  const issues = [];
  for (const section of d.root.sections) {
    for (const block of section.children || []) {
      const errs = validateBlock(block);
      if (errs.length > 0) {
        issues.push({ blockId: block.id, blockName: block.name, blockType: block.type, errors: errs });
      }
    }
  }
  return issues;
}

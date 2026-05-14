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

// CSS media-query boundaries used by the public renderer. Matches the
// runtime detection in useActiveBreakpoint: w < 640 → mobile, w < 1024 →
// tablet, otherwise desktop. We emit tablet/mobile rules inside
// @media (max-width: …) queries so layout is correct without any JS.
export const BREAKPOINT_MAX_PX = {
  tablet: 1023.98,
  mobile: 639.98,
};

// ARIA roles that have a matching HTML5 landmark element. Sections in the
// inspector can pick a role and the public renderer will swap the wrapper
// to the corresponding semantic tag. Roles not in this map render as a
// neutral <div> with a `role` attribute.
export const LANDMARK_ROLE_TO_TAG = {
  banner: 'header',
  header: 'header',
  contentinfo: 'footer',
  footer: 'footer',
  navigation: 'nav',
  nav: 'nav',
  main: 'main',
  complementary: 'aside',
  aside: 'aside',
  region: 'section',
  section: 'section',
};

export function getLandmarkTag(role) {
  if (!role) return null;
  return LANDMARK_ROLE_TO_TAG[String(role).toLowerCase()] || null;
}

// Returns a landmark tag only for blocks that may legitimately wrap a
// landmark region (sections). Block types like images, buttons, text, etc.
// keep `role=` as an attribute but are never upgraded to header/nav/main/
// aside/footer — this prevents invalid HTML and nested-<main> landmarks.
// Also excludes `main`: the page already provides a single top-level
// <main>, so block-level main roles fall back to <section>.
export function getSectionLandmarkTag(blockType, role) {
  if (blockType !== BLOCK_TYPES.SECTION) return null;
  const tag = getLandmarkTag(role);
  if (!tag || tag === 'main') return null;
  return tag;
}

// ---------------------------------------------------------------------------
// Responsive image helpers
//
// For images hosted on allow-listed CDNs (Supabase Storage public buckets;
// vault.iconn.app falls through to the proxy used elsewhere) we emit a
// real srcset + sizes so the browser can pick an appropriately-sized
// asset. Other hosts pass through unchanged — no transforms, no srcset.
// This mirrors the host allow-list used by `api/og-image.js`.
// ---------------------------------------------------------------------------

const RESPONSIVE_IMAGE_WIDTHS = [400, 800, 1200, 1600];

function isAllowedImageHost(hostname) {
  if (!hostname) return false;
  if (hostname === 'vault.iconn.app') return true;
  if (hostname.endsWith('.supabase.co')) return true;
  return false;
}

export function buildResponsiveImage(src, { sizes } = {}) {
  const out = { src: src || '', srcSet: undefined, sizes };
  if (!src) return out;
  try {
    const u = new URL(src, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    if (!isAllowedImageHost(u.hostname)) return out;
    // Supabase Storage: object public URLs can be reissued through the
    // image transformer at /render/image/public/...
    if (u.hostname.endsWith('.supabase.co') && u.pathname.includes('/storage/v1/object/public/')) {
      const transformPath = u.pathname.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/');
      const base = `${u.origin}${transformPath}`;
      const srcSet = RESPONSIVE_IMAGE_WIDTHS
        .map((w) => `${base}?width=${w}&quality=80 ${w}w`)
        .join(', ');
      return {
        src: `${base}?width=1200&quality=80`,
        srcSet,
        sizes: sizes || '100vw',
      };
    }
    // Other allow-listed hosts: emit sizes for the browser hint, no srcset.
    return { src, srcSet: undefined, sizes: sizes || '100vw' };
  } catch {
    return out;
  }
}

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
  // Dynamic / data-bound blocks (Phase 4)
  EVENT_LIST: 'event-list',
  EVENT_TEASER: 'event-teaser',
  ARTICLE_LIST: 'article-list',
  RESOURCE_LIST: 'resource-list',
  FORM_EMBED: 'form-embed',
  CAMPAIGN_EMBED: 'campaign-embed',
  MEMBER_DIRECTORY_EMBED: 'member-directory-embed',
  DYNAMIC_DIRECTORY_EMBED: 'dynamic-directory-embed',
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
  // ---- Dynamic blocks ----
  [BLOCK_TYPES.EVENT_LIST]: {
    name: 'Event list',
    geom: { w: 800, h: 520 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      title: 'Upcoming events',
      headingLevel: 2,
      limit: 6,
      filter: 'upcoming', // upcoming | past | all
      featuredOnly: false,
      programTag: '',
      sortBy: 'start-asc',
      columns: { desktop: 3, tablet: 2, mobile: 1 },
      gap: 16,
      ctaLabel: 'View details',
      emptyText: 'No upcoming events to show yet.',
    },
  },
  [BLOCK_TYPES.EVENT_TEASER]: {
    name: 'Event teaser',
    geom: { w: 520, h: 320 },
    style: { background: '#ffffff', borderWidth: 1, borderRadius: 8 },
    content: {
      eventId: '',
      eventSlug: '',
      showImage: true,
      showSummary: true,
      showCta: true,
      ctaLabel: 'Find out more',
    },
  },
  [BLOCK_TYPES.ARTICLE_LIST]: {
    name: 'Article / news list',
    geom: { w: 800, h: 520 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      title: 'Latest articles',
      headingLevel: 2,
      source: 'articles', // articles | news
      limit: 6,
      tag: '',
      columns: { desktop: 3, tablet: 2, mobile: 1 },
      gap: 16,
      showSummary: true,
      showImage: true,
      emptyText: 'No articles yet.',
    },
  },
  [BLOCK_TYPES.RESOURCE_LIST]: {
    name: 'Resource list',
    geom: { w: 800, h: 520 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      title: 'Resources',
      headingLevel: 2,
      limit: 6,
      resourceType: '',
      tag: '',
      columns: { desktop: 3, tablet: 2, mobile: 1 },
      gap: 16,
      emptyText: 'No resources available.',
    },
  },
  [BLOCK_TYPES.FORM_EMBED]: {
    name: 'Form embed',
    geom: { w: 640, h: 480 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      formSlug: '',
      mode: 'inline', // inline | iframe | link
      title: '',
      ctaLabel: 'Open form',
    },
  },
  [BLOCK_TYPES.CAMPAIGN_EMBED]: {
    name: 'Fundraising campaign',
    geom: { w: 560, h: 380 },
    style: { background: '#ffffff', borderWidth: 1, borderRadius: 8 },
    content: {
      campaignSlug: '',
      showProgress: true,
      showImage: true,
      ctaLabel: 'Donate now',
    },
  },
  [BLOCK_TYPES.MEMBER_DIRECTORY_EMBED]: {
    name: 'Member directory',
    geom: { w: 800, h: 520 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      directorySlug: '',
      title: 'Member directory',
      headingLevel: 2,
      limit: 12,
      sort: 'name-asc',
      columns: { desktop: 3, tablet: 2, mobile: 1 },
      gap: 16,
      showPhoto: true,
      showJobTitle: true,
      ctaLabel: 'View directory',
      emptyText: 'No members to show yet.',
    },
  },
  [BLOCK_TYPES.DYNAMIC_DIRECTORY_EMBED]: {
    name: 'Dynamic directory',
    geom: { w: 800, h: 520 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      directorySlug: '',
      title: '',
      headingLevel: 2,
      limit: 12,
      sort: 'name-asc',
      columns: { desktop: 3, tablet: 2, mobile: 1 },
      gap: 16,
      showPhoto: true,
      ctaLabel: 'View full directory',
      emptyText: 'No records to show yet.',
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
    case BLOCK_TYPES.EVENT_TEASER:
      if (!c.eventId && !c.eventSlug) errors.push('Event teaser requires an event.');
      break;
    case BLOCK_TYPES.FORM_EMBED:
      if (!c.formSlug) errors.push('Form embed requires a form.');
      break;
    case BLOCK_TYPES.CAMPAIGN_EMBED:
      if (!c.campaignSlug) errors.push('Campaign embed requires a campaign.');
      break;
    case BLOCK_TYPES.DYNAMIC_DIRECTORY_EMBED:
      if (!c.directorySlug) errors.push('Dynamic directory embed requires a directory.');
      break;
    case BLOCK_TYPES.MEMBER_DIRECTORY_EMBED:
      if (!c.directorySlug) errors.push('Member directory embed requires a directory.');
      break;
    default:
      break;
  }
  return errors;
}

// ---------------------------------------------------------------------------
// CSS emission for the public renderer
//
// The editor uses runtime JS to layout absolutely-positioned blocks at the
// detected breakpoint. For public pages we instead emit a self-contained
// per-page stylesheet with @media queries so layout is correct on the
// initial render with zero JS — important for SSR, prerender, Lighthouse
// LCP/CLS scores, and clients that block JS.
// ---------------------------------------------------------------------------

function escapeCssIdent(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function fmtPx(n) {
  return `${Math.round(Number(n) || 0)}px`;
}

function geomRule(geom, { fullBleed } = {}) {
  if (geom.hidden) return 'display:none;';
  if (fullBleed) {
    return [
      'display:block;',
      'position:absolute;',
      'left:50%;',
      'transform:translateX(-50%);',
      'width:100vw;',
      `top:${fmtPx(geom.y)};`,
      `height:${fmtPx(geom.h)};`,
    ].join('');
  }
  return [
    'display:block;',
    'position:absolute;',
    `left:${fmtPx(geom.x)};`,
    `top:${fmtPx(geom.y)};`,
    `width:${fmtPx(geom.w)};`,
    `height:${fmtPx(geom.h)};`,
  ].join('');
}

function stageHeightForBreakpoint(blocks, breakpoint) {
  let h = 240;
  for (const b of blocks) {
    const g = resolveBlockAtBreakpoint(b, breakpoint);
    if (g.hidden) continue;
    h = Math.max(h, (g.y || 0) + (g.h || 0) + 80);
  }
  return h;
}

/**
 * Build a CSS stylesheet for a Canvas page. Scoped under `scope` (any CSS
 * selector, e.g. `#canvas-abc123`) so multiple Canvas pages can coexist
 * on a document without rule collisions.
 */
export function buildCanvasCss(blocks, scope) {
  const lines = [];
  const sc = scope || '.canvas-page';

  // Stage heights per breakpoint.
  const hD = stageHeightForBreakpoint(blocks, 'desktop');
  const hT = stageHeightForBreakpoint(blocks, 'tablet');
  const hM = stageHeightForBreakpoint(blocks, 'mobile');
  const stageSel = `${sc} .canvas-stage`;
  lines.push(`${stageSel}{position:relative;width:100%;max-width:${BREAKPOINT_WIDTHS.desktop}px;margin:0 auto;height:${fmtPx(hD)};}`);

  for (const b of blocks) {
    const id = escapeCssIdent(b.id);
    const sel = `${sc} [data-cb="${id}"]`;
    const isSection = b.type === BLOCK_TYPES.SECTION;
    const fullBleed = isSection && !!(b.content && b.content.fullBleed);
    const dG = resolveBlockAtBreakpoint(b, 'desktop');
    lines.push(`${sel}{${geomRule(dG, { fullBleed })}}`);
  }

  // Tablet overrides.
  const tabletRules = [];
  for (const b of blocks) {
    const id = escapeCssIdent(b.id);
    const sel = `${sc} [data-cb="${id}"]`;
    const isSection = b.type === BLOCK_TYPES.SECTION;
    const fullBleed = isSection && !!(b.content && b.content.fullBleed);
    const dG = resolveBlockAtBreakpoint(b, 'desktop');
    const tG = resolveBlockAtBreakpoint(b, 'tablet');
    if (
      tG.x !== dG.x || tG.y !== dG.y || tG.w !== dG.w || tG.h !== dG.h ||
      !!tG.hidden !== !!dG.hidden
    ) {
      tabletRules.push(`${sel}{${geomRule(tG, { fullBleed })}}`);
    }
  }
  if (tabletRules.length) {
    lines.push(`@media (max-width: ${BREAKPOINT_MAX_PX.tablet}px){`);
    lines.push(`${stageSel}{max-width:${BREAKPOINT_WIDTHS.tablet}px;height:${fmtPx(hT)};}`);
    lines.push(tabletRules.join(''));
    lines.push('}');
  } else {
    lines.push(`@media (max-width: ${BREAKPOINT_MAX_PX.tablet}px){${stageSel}{max-width:${BREAKPOINT_WIDTHS.tablet}px;height:${fmtPx(hT)};}}`);
  }

  // Mobile overrides.
  const mobileRules = [];
  for (const b of blocks) {
    const id = escapeCssIdent(b.id);
    const sel = `${sc} [data-cb="${id}"]`;
    const isSection = b.type === BLOCK_TYPES.SECTION;
    const fullBleed = isSection && !!(b.content && b.content.fullBleed);
    const tG = resolveBlockAtBreakpoint(b, 'tablet');
    const mG = resolveBlockAtBreakpoint(b, 'mobile');
    if (
      mG.x !== tG.x || mG.y !== tG.y || mG.w !== tG.w || mG.h !== tG.h ||
      !!mG.hidden !== !!tG.hidden
    ) {
      mobileRules.push(`${sel}{${geomRule(mG, { fullBleed })}}`);
    }
  }
  if (mobileRules.length) {
    lines.push(`@media (max-width: ${BREAKPOINT_MAX_PX.mobile}px){`);
    lines.push(`${stageSel}{max-width:${BREAKPOINT_WIDTHS.mobile}px;height:${fmtPx(hM)};}`);
    lines.push(mobileRules.join(''));
    lines.push('}');
  } else {
    lines.push(`@media (max-width: ${BREAKPOINT_MAX_PX.mobile}px){${stageSel}{max-width:${BREAKPOINT_WIDTHS.mobile}px;height:${fmtPx(hM)};}}`);
  }

  return lines.join('\n');
}

/**
 * Identify the LCP-candidate block on a page. Heuristic: the first
 * visible-at-desktop image-bearing block (hero w/ image background, image
 * block w/ src, or card w/ image), reading in document order, top-down.
 */
export function findLcpBlockId(blocks) {
  const candidates = blocks
    .map((b) => ({ b, g: resolveBlockAtBreakpoint(b, 'desktop') }))
    .filter(({ b, g }) => {
      if (g.hidden) return false;
      const c = b.content || {};
      if (b.type === BLOCK_TYPES.HERO && c.bgType === 'image' && c.bgImageUrl) return true;
      if (b.type === BLOCK_TYPES.IMAGE && c.src) return true;
      if (b.type === BLOCK_TYPES.CARD && c.imageUrl) return true;
      return false;
    })
    .sort((a, b) => (a.g.y || 0) - (b.g.y || 0));
  return candidates.length ? candidates[0].b.id : null;
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

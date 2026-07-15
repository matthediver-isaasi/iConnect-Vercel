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

// Task #2558 — flow (auto-layout) schema. Version 2 documents describe the page
// as an ordered tree of containers (section → row → group → element) where
// vertical position is DERIVED from block order + measured height, not stored.
// Version 1 (absolute x/y coordinates) and version 2 coexist during rollout:
// `isFlowDesign()` selects which normalizer / renderer path applies. Newly
// created pages and the autobuild generator still emit v1 by default until the
// flow renderer (Step 2) and builder (Step 3) land — so version 1 remains the
// live default and there is no user-facing behaviour change from this step.
export const CANVAS_FLOW_VERSION = 2;

// Per-node layout mode. `flow` = children participate in auto-layout (their
// position is derived from order + measured height, and editing one reflows
// the rest inside AND outside the container). `free` = children are placed
// absolutely by their per-breakpoint geometry and may overlap; the free
// container is rigid internally but is still a normal flow item in its parent.
export const LAYOUT_MODES = { FLOW: 'flow', FREE: 'free' };

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
  VERTICAL_DIVIDER: 'vertical-divider',
  ACCORDION: 'accordion',
  TESTIMONIALS: 'testimonials',
  CUSTOM_HTML: 'custom-html',
  ICON: 'icon',
  CARD: 'card',
  STAT: 'stat',
  LOGO_STRIP: 'logo-strip',
  MAP: 'map',
  PRICING_TABLE: 'pricing-table',
  TESTIMONIAL_GRID: 'testimonial-grid',
  NEWS_TICKER: 'news-ticker',
  MEGA_MENU: 'mega-menu',
  COUNTDOWN: 'countdown',
  // Dynamic / data-bound blocks (Phase 4)
  EVENT_LIST: 'event-list',
  EVENT_TEASER: 'event-teaser',
  EVENT_SESSIONS: 'event-sessions',
  EVENT_CAROUSEL: 'event-carousel',
  SPEAKER_CAROUSEL: 'speaker-carousel',
  SPEAKER_GRID: 'speaker-grid',
  SPONSOR_GRID: 'sponsor-grid',
  SPONSOR_CAROUSEL: 'sponsor-carousel',
  ARTICLE_LIST: 'article-list',
  RESOURCE_LIST: 'resource-list',
  FORM_EMBED: 'form-embed',
  CAMPAIGN_EMBED: 'campaign-embed',
  MEMBER_DIRECTORY_EMBED: 'member-directory-embed',
  DYNAMIC_DIRECTORY_EMBED: 'dynamic-directory-embed',
  CARD_DECK: 'card-deck',
  WALL_OF_FAME: 'wall-of-fame',
  GALLERY: 'gallery',
  CARD_FLIP_GRID: 'card-flip-grid',
  HERO_CAROUSEL: 'hero-carousel',
  // Reusable section symbols (Phase 7). A symbol block stores a `symbolId`
  // and is rendered by inlining the referenced canvas_symbol design.
  SYMBOL: 'symbol',
  // System: tenant-customisable login form block (fixed size, position-only).
  LOGIN_FORM: 'login-form',
  // Styled public-search field that reuses /api/public/search.
  SEARCH_INPUT: 'search-input',
  // Task #2558 — flow (auto-layout) layout containers. `row` lays its children
  // out horizontally as columns (the real Row/Columns primitive that replaces
  // expressing side-by-side layouts with X coordinates); `group` is a
  // free-position cluster whose children are placed absolutely and may overlap.
  // Both are containers: they carry a `children` array and a `layoutMode`.
  ROW: 'row',
  GROUP: 'group',
};

// Block types whose accessible name already comes from their own content, so
// the generic `aria-label` input in the inspector would be misleading or
// redundant and is deliberately hidden for them:
//  - TEXT: the visible words ARE the accessible name. An aria-label would
//    silently REPLACE that copy, and the role-less wrapper it lands on is
//    ignored by most screen readers anyway.
//  - IMAGE / CARD: these carry their own dedicated Alt text input. aria-label
//    overrides alt when both are set, so exposing both is confusing.
// Every other block type (icon, divider, spacer, box/section, video, map, logo
// strip, etc.) has no intrinsic readable text, so it keeps the aria-label
// input where it genuinely adds value.
export const BLOCK_TYPES_WITHOUT_ARIA_LABEL = new Set([
  BLOCK_TYPES.TEXT,
  BLOCK_TYPES.IMAGE,
  BLOCK_TYPES.CARD,
]);

// Whether the inspector should show the generic aria-label input for a block.
export function blockSupportsAriaLabelInput(type) {
  return !BLOCK_TYPES_WITHOUT_ARIA_LABEL.has(type);
}

// Container block types in the flow model. A container carries a `children`
// array and a `layoutMode`; a leaf does not. `section` already exists as a
// visual box in v1 but becomes a flow container in v2.
export const FLOW_CONTAINER_TYPES = new Set([
  BLOCK_TYPES.SECTION,
  BLOCK_TYPES.ROW,
  BLOCK_TYPES.GROUP,
]);

export function isFlowContainerType(type) {
  return FLOW_CONTAINER_TYPES.has(type);
}

// Block types that support the "full-bleed" treatment — a true 100vw
// viewport-edge breakout (vs. the generic `fullWidth`, which only fills the
// centered design stage). fullBleed lives on `block.content.fullBleed` and is
// rendered by geomRule() (static stylesheet) AND CanvasPageRenderer (forced
// breakpoint path); keep BOTH consumers driven off this single list.
export const FULL_BLEED_BLOCK_TYPES = new Set([
  BLOCK_TYPES.SECTION,
  BLOCK_TYPES.HERO,
  BLOCK_TYPES.HERO_CAROUSEL,
  BLOCK_TYPES.NEWS_TICKER,
  BLOCK_TYPES.MEGA_MENU,
  BLOCK_TYPES.WALL_OF_FAME,
  BLOCK_TYPES.TESTIMONIALS,
  BLOCK_TYPES.TESTIMONIAL_GRID,
  BLOCK_TYPES.FORM_EMBED,
  BLOCK_TYPES.SPONSOR_CAROUSEL,
  BLOCK_TYPES.IMAGE,
]);

export function blockSupportsFullBleed(type) {
  return FULL_BLEED_BLOCK_TYPES.has(type);
}

// True when a block should behave like a full-width block for *editor*
// geometry purposes: either the generic `fullWidth` flag is set, or the
// block opts into `fullBleed` (a viewport-edge breakout that the editor
// approximates by spanning the full canvas width). The published CSS path
// renders true `fullBleed` as 100vw via geomRule; this helper only governs
// how the block is laid out / locked inside the design canvas.
export function blockIsFullWidthLike(block) {
  if (!block) return false;
  if (block.fullWidth) return true;
  return blockSupportsFullBleed(block.type) && !!(block.content && block.content.fullBleed);
}

// Task #2506: toggle `content.fullBleed` with snapshot-on-release semantics,
// mirroring the Position panel's Full width toggle. While full-bleed is on,
// the editor pins the rendered frame to x=0 / w=stage-width — so when it is
// turned OFF we first write that currently rendered x/w into the active
// breakpoint frame. The block keeps its visual size and the X/Width inputs
// work immediately instead of snapping back to a stale stored frame.
// Turning ON just sets the flag (stored frames are preserved underneath the
// pin, same as fullWidth). Used by BOTH the Position panel's Full-bleed
// control and block content inspectors (e.g. the Hero's toggle) so the two
// entry points can't drift.
export function setBlockContentFullBleed(block, breakpoint, on) {
  if (on) {
    return { ...block, content: { ...block.content, fullBleed: true } };
  }
  const cw = BREAKPOINT_WIDTHS[breakpoint] || BREAKPOINT_WIDTHS.desktop;
  const withGeom = setBlockBp(block, breakpoint, { x: 0, w: cw });
  return { ...withGeom, content: { ...withGeom.content, fullBleed: false } };
}

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
  // Task #2692 — drop shadow. Stored as a curated preset level key
  // (see SHADOW_LEVELS); 'none' is the default so existing pages are
  // byte-identical. resolveBoxShadowCss() maps the key to a CSS value and
  // is the single source of truth applied inline on every render surface.
  boxShadow: 'none',
};

// Task #2692 — curated drop-shadow preset levels. The KEY is what is stored
// on block.style.boxShadow; the value is the CSS `box-shadow` string emitted
// on every render surface. This is the ONE source of truth referenced by the
// Inspector picker (options) AND by resolveBoxShadowCss (render) so the
// builder and the published page can never drift. Shadows use a soft neutral
// tint that reads well on light and (subtly) dark backgrounds.
export const SHADOW_LEVELS = [
  { value: 'none', label: 'None', css: 'none' },
  { value: 'sm', label: 'Small', css: '0 1px 2px 0 rgba(15, 23, 42, 0.08)' },
  { value: 'md', label: 'Medium', css: '0 4px 6px -1px rgba(15, 23, 42, 0.10), 0 2px 4px -2px rgba(15, 23, 42, 0.10)' },
  { value: 'lg', label: 'Large', css: '0 10px 15px -3px rgba(15, 23, 42, 0.12), 0 4px 6px -4px rgba(15, 23, 42, 0.10)' },
  { value: 'xl', label: 'Extra large', css: '0 20px 25px -5px rgba(15, 23, 42, 0.14), 0 8px 10px -6px rgba(15, 23, 42, 0.10)' },
];

const SHADOW_CSS_BY_LEVEL = SHADOW_LEVELS.reduce((acc, l) => {
  acc[l.value] = l.css;
  return acc;
}, {});

// Map a block's stored shadow level to its CSS `box-shadow` value. Unknown or
// missing values (including legacy blocks with no boxShadow field) resolve to
// 'none' so nothing changes appearance until an author opts in.
export function resolveBoxShadowCss(style) {
  const level = style && typeof style === 'object' ? style.boxShadow : null;
  return SHADOW_CSS_BY_LEVEL[level] || 'none';
}

// Block types that expose the drop-shadow control. Restricted to the
// container/media surfaces where a shadow makes sense (Task #2692).
export const SHADOW_BLOCK_TYPES = new Set([
  BLOCK_TYPES.BOX,
  BLOCK_TYPES.SECTION,
  BLOCK_TYPES.IMAGE,
]);

export function blockSupportsShadow(type) {
  return SHADOW_BLOCK_TYPES.has(type);
}

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
    // bgType defaults to 'color' so existing sections (which won't have
    // any of the new fields) are byte-identical to today. The overlay
    // fields are only consulted when bgType === 'image'.
    //
    // Multipoint gradients: `gradientStops` (an array of { color, opacity,
    // position } stops) is the source of truth for the gradient background
    // when present with 2+ stops. It is deliberately NOT seeded here — adding
    // it to the defaults would make normalizeBlock backfill it onto every
    // legacy gradient section and override their customised from/to colours.
    // Instead the gradient builder falls back to the legacy two-stop
    // from/to (linear) and centre/edge (radial) fields whenever the stops
    // array is absent, and the inspector seeds a sensible two-stop list from
    // those legacy fields on the author's first edit.
    content: {
      maxWidth: 0,
      fullBleed: false,
      bgType: 'color',
      bgImageUrl: '',
      overlayType: 'solid',
      overlayBlendMode: 'normal',
      overlayColor: '#000000',
      overlayOpacity: 0.4,
      overlayFromColor: '#000000',
      overlayFromOpacity: 0.6,
      overlayToColor: '#000000',
      overlayToOpacity: 0,
      overlayAngle: 180,
      overlayCenterColor: '#000000',
      overlayCenterOpacity: 0,
      overlayEdgeColor: '#000000',
      overlayEdgeOpacity: 0.6,
    },
  },
  [BLOCK_TYPES.HERO]: {
    name: 'Hero',
    // Theme tokens — the renderer scopes --cb-color-* / --cb-font-* vars
    // onto every canvas page (from tenant_canvas_theme). Defaulting to
    // var() with a hardcoded fallback means new blocks pick up tenant
    // branding automatically while still rendering sensibly when no
    // theme is configured.
    geom: { w: 800, h: 420 },
    style: { background: 'var(--cb-color-primary, #0f172a)', borderWidth: 0, borderRadius: 0, paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24 },
    a11y: {},
    content: {
      headline: 'Your headline here',
      headingLevel: 1,
      subheadline: 'A short supporting message that frames the page.',
      bgType: 'color',
      bgColor: 'var(--cb-color-primary, #0f172a)',
      bgImageUrl: '',
      bgVideoUrl: '',
      darkWash: 0.4,
      // Overlay style: 'solid' keeps the legacy flat black wash driven by
      // darkWash; 'gradient' renders a linear gradient along overlayDirection.
      // Absent/old data is treated as solid so saved pages render
      // byte-identically until the user opts into a gradient.
      //
      // Multipoint gradients: `overlayStops` (an array of { color, opacity,
      // position } stops) is the source of truth for the gradient overlay when
      // present with 2+ stops. It is deliberately NOT seeded here — adding it to
      // the defaults would make normalizeBlock backfill it onto every legacy
      // hero and override their customised from/to colours. The overlay builder
      // falls back to the legacy two-stop overlayFrom*/overlayTo* fields when
      // the stops array is absent, and the inspector seeds a sensible two-stop
      // list from those legacy fields on the author's first edit.
      overlayStyle: 'solid',
      overlayFromColor: '#000000',
      overlayFromOpacity: 0.6,
      overlayToColor: '#000000',
      overlayToOpacity: 0,
      overlayDirection: 'to-top',
      overlayAngle: 0,
      fullBleed: false,
      alignment: 'center',
      textColor: 'var(--cb-color-on-primary, #ffffff)',
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
      // Custom bullet-list icon (Font Awesome). Empty bulletIcon = standard
      // disc bullets (no change to existing blocks). When set, every <ul> in
      // the block renders this icon as its marker in the chosen colour/size.
      bulletIcon: '', // e.g. 'fa-solid fa-book-open'
      bulletIconColor: '', // hex; empty = inherit text colour
      bulletIconSize: null, // px number; empty/null = default (~1em)
      // Padding (px) around the bullet icon. All null = legacy spacing
      // (1.6em hanging indent). Left = icon offset from the edge; right = gap
      // between the icon and the text; top/bottom = vertical space around the
      // icon row. The list text inset is derived from left + icon size + right
      // so a larger icon never overruns the text.
      bulletIconPadTop: null,
      bulletIconPadRight: null,
      bulletIconPadBottom: null,
      bulletIconPadLeft: null,
      // Per-block character-spacing override (px number). null/undefined =
      // inherit from the selected tenant typography style (or browser default).
      characterSpacing: null,
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
      fullBleed: false,
      // When full-bleed is on the block spans 100vw; heightMode controls how
      // its height is resolved on published pages:
      //   'auto' (default) — use the block geometry height (drag-to-resize)
      //   'px'             — fixed pixel height from heightValue
      //   'vh'             — viewport-relative height (heightValue + 'vh')
      heightMode: 'auto',
      heightValue: null,
      // Font Awesome icon (alternative to image)
      iconClass: '',
      iconSize: 64,
      iconColor: '',
      iconAlign: 'center',
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
  // Task #2558 — flow Row container. Lays its children out horizontally as
  // columns. `content.columns` is the desired column count per breakpoint;
  // tablet/mobile default to stacking. Widths are derived by the layout
  // engine from each child's `flow.basis`/`flow.grow` (equal split when unset).
  [BLOCK_TYPES.ROW]: {
    name: 'Row',
    geom: { w: 900, h: 200 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      columns: { desktop: 2, tablet: 2, mobile: 1 },
      // Whether tablet/mobile collapse the row into a vertical stack.
      stackTablet: false,
      stackMobile: true,
    },
  },
  // Task #2558 — free-position group. A cluster of children placed absolutely
  // (by their per-breakpoint geometry) that may overlap — used to preserve
  // heros/badges-on-images/overlapping cards when migrating v1 pages. Rigid
  // internally, but flows as one item in its parent.
  [BLOCK_TYPES.GROUP]: {
    name: 'Group',
    geom: { w: 900, h: 300 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {},
  },
  [BLOCK_TYPES.DIVIDER]: {
    name: 'Divider',
    geom: { w: 400, h: 24 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      lineStyle: 'solid', // solid | dashed | dotted
      color: 'var(--cb-color-border, #e2e8f0)',
      thickness: 1,
    },
  },
  [BLOCK_TYPES.VERTICAL_DIVIDER]: {
    name: 'Vertical Divider',
    geom: { w: 24, h: 200 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      lineStyle: 'solid', // solid | dashed | dotted
      color: 'var(--cb-color-border, #e2e8f0)',
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
      questionFontSize: 14,
      itemGap: 8,
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
      cardPadding: 12,
      cardBgColor: '',
      cardBorderColor: '',
      quoteTypographyStyleId: '',
      attributionTypographyStyleId: '',
      fullBleed: false,
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
      color: 'var(--cb-color-primary, #0f172a)',
      size: 48,
      ariaLabel: '',
    },
  },
  [BLOCK_TYPES.CARD]: {
    name: 'Card',
    geom: { w: 320, h: 380 },
    style: { background: 'var(--cb-color-surface, #ffffff)', borderWidth: 1, borderColor: 'var(--cb-color-border, #e2e8f0)', borderRadius: 8, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0 },
    content: {
      imageUrl: '',
      imageAlt: '',
      // Image layout: 'full-bleed' (legacy default — cropped header image) or
      // 'inline' (uncropped, sized to a % of the card width and aligned).
      imageDisplayMode: 'full-bleed',
      imageWidthPct: 100,
      imageAlign: 'center',
      // Optional Font Awesome icon rendered above the heading (e.g.
      // 'fa-solid fa-book-open'). Empty by default so existing cards are
      // unchanged.
      iconClass: '',
      iconSize: 32,
      iconAlign: 'left',
      iconColor: '',
      // Vertical gap (px) between the image/icon and the heading.
      // null = "not set by author"; renderer falls back to the legacy
      // per-element defaults (mb-2 for icon/inline, no margin for full-bleed).
      headerSpacing: null,
      heading: 'Card heading',
      headingLevel: 3,
      body: '<p>A short description for this card.</p>',
      contentPadding: 16,
      // CTA is shown by default so existing cards (which always rendered the
      // CTA when a label was present) are unchanged.
      ctaEnabled: true,
      ctaLabel: 'Learn more',
      ctaHref: '#',
      ctaVariant: 'outline',
      ctaAlign: 'left',
      // Drop shadow ('none' | 'sm' | 'md' | 'lg') + optional highlight ring.
      shadow: 'none',
      highlight: false,
      highlightColor: '#3b82f6',
    },
  },
  [BLOCK_TYPES.STAT]: {
    name: 'Stat',
    geom: { w: 240, h: 140 },
    style: {
      background: '#ffffff',
      borderColor: '#f3f4f6',
      borderWidth: 1,
      borderStyle: 'solid',
      borderRadius: 12,
      paddingTop: 16,
      paddingRight: 16,
      paddingBottom: 16,
      paddingLeft: 16,
    },
    content: {
      value: '2,500+',
      label: 'Members',
      color: '#ea7f21',
      labelColor: '',
      valueFontSize: 30,
      labelFontSize: 14,
      // Counter animation: when `animate` is true the value's numeric
      // portion counts up from zero to the target on first scroll into
      // view. Non-numeric prefix/suffix (e.g. "$", "+", "K") are
      // preserved and the thousands-separator pattern from the saved
      // value is re-applied to each intermediate frame.
      animate: false,
      animationDurationMs: 1500,
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
  [BLOCK_TYPES.PRICING_TABLE]: {
    name: 'Pricing table',
    geom: { w: 960, h: 520 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      heading: 'Pricing',
      headingLevel: 2,
      subheading: 'Simple, transparent pricing that scales with you.',
      billingToggle: false,
      defaultBilling: 'monthly', // monthly | annual
      monthlyLabel: 'Monthly',
      annualLabel: 'Annual',
      annualNote: 'Save 2 months',
      columns: { desktop: 3, tablet: 2, mobile: 1 },
      gap: 16,
      recommendedBadgeLabel: 'Most popular',
      // Tenant typography controls (heading / sub-heading / card content).
      // Empty/null defaults keep existing blocks visually identical — when no
      // style id or size/colour override is set the renderer falls back to the
      // legacy hardcoded styling, so saved blocks render unchanged.
      headingTypographyStyleId: '',
      headingFontSize: null,
      headingColor: '',
      subheadingTypographyStyleId: '',
      subheadingFontSize: null,
      subheadingColor: '',
      cardTypographyStyleId: '',
      cardFontSize: null,
      cardColor: '',
      // Feature glyph colours. Empty defaults preserve the legacy look:
      // tick uses the primary CSS var, cross uses the muted CSS var.
      tickColor: '',
      crossColor: '',
      tiers: [
        {
          name: 'Starter',
          monthlyPrice: '£0',
          annualPrice: '£0',
          period: '/month',
          description: 'For trying things out.',
          features: [
            { text: 'Up to 25 members', included: true, tooltip: '' },
            { text: 'Email support', included: true, tooltip: '' },
            { text: 'Basic reporting', included: true, tooltip: '' },
            { text: 'Custom domain', included: false, tooltip: 'Available on Growth and above' },
          ],
          ctaLabel: 'Get started',
          ctaHref: '#',
          ctaVariant: 'outline',
          recommended: false,
        },
        {
          name: 'Growth',
          monthlyPrice: '£29',
          annualPrice: '£290',
          period: '/month',
          description: 'For growing organisations.',
          features: [
            { text: 'Up to 500 members', included: true, tooltip: '' },
            { text: 'Workflows & automations', included: true, tooltip: '' },
            { text: 'Priority support', included: true, tooltip: '' },
            { text: 'Custom domain', included: true, tooltip: '' },
          ],
          ctaLabel: 'Choose Growth',
          ctaHref: '#',
          ctaVariant: 'primary',
          recommended: true,
        },
        {
          name: 'Pro',
          monthlyPrice: '£79',
          annualPrice: '£790',
          period: '/month',
          description: 'For established teams.',
          features: [
            { text: 'Unlimited members', included: true, tooltip: '' },
            { text: 'Custom domain', included: true, tooltip: '' },
            { text: 'Dedicated success manager', included: true, tooltip: '' },
            { text: 'SSO / SAML', included: true, tooltip: 'Single sign-on via SAML 2.0' },
          ],
          ctaLabel: 'Choose Pro',
          ctaHref: '#',
          ctaVariant: 'outline',
          recommended: false,
        },
      ],
    },
  },
  [BLOCK_TYPES.TESTIMONIAL_GRID]: {
    name: 'Testimonial grid',
    geom: { w: 960, h: 480 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      heading: 'What our customers say',
      headingLevel: 2,
      headingTypographyStyleId: '',
      quoteTypographyStyleId: '',
      attributionTypographyStyleId: '',
      columns: { desktop: 3, tablet: 2, mobile: 1 },
      gap: 16,
      fullBleed: false,
      innerPaddingTop: 0,
      innerPaddingRight: 0,
      innerPaddingBottom: 0,
      innerPaddingLeft: 0,
      items: [
        {
          quote: 'Switching saved us hours every single week. The team is happier and our members notice the difference.',
          author: 'Alex Morgan',
          role: 'Operations Lead',
          company: 'Acme Co.',
          avatarUrl: '',
          avatarAlt: '',
          companyLogoUrl: '',
          companyLogoAlt: '',
        },
        {
          quote: 'The page builder is genuinely a joy to use. We launched our new site in an afternoon.',
          author: 'Priya Shah',
          role: 'Marketing Director',
          company: 'Bright Foundation',
          avatarUrl: '',
          avatarAlt: '',
          companyLogoUrl: '',
          companyLogoAlt: '',
        },
        {
          quote: 'Best investment we made this year. Support is fast and the product keeps getting better.',
          author: 'Sam Okafor',
          role: 'Membership Manager',
          company: 'Northwind Society',
          avatarUrl: '',
          avatarAlt: '',
          companyLogoUrl: '',
          companyLogoAlt: '',
        },
      ],
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
  [BLOCK_TYPES.NEWS_TICKER]: {
    name: 'News Ticker',
    geom: { w: 720, h: 48 },
    style: { background: 'transparent', borderWidth: 0, borderRadius: 4 },
    content: {
      // Free-form text items typed by the editor (NOT linked to news
      // articles — that's the portal-wide NewsTickerBar's job).
      items: [
        { text: 'Welcome — share your latest announcement here.' },
        { text: 'Add, edit, reorder, or remove items in the Inspector.' },
        { text: 'Switch between cycling and scrolling display modes.' },
      ],
      label: 'Latest:',
      mode: 'cycling', // cycling | scrolling
      // Cycling: seconds each item is shown. Scrolling: seconds per item
      // as it travels across the bar (drives marquee duration).
      intervalSeconds: 5,
      // Defaults echo the portal ticker's purple bar.
      backgroundColor: '#9333ea',
      textColor: '#ffffff',
      fullBleed: false,
    },
  },
  [BLOCK_TYPES.MEGA_MENU]: {
    name: 'Mega Menu',
    geom: { w: 960, h: 56 },
    style: { background: 'transparent', borderWidth: 0, borderRadius: 4 },
    content: {
      // A manually-built navigation bar placed on a specific page. Fully
      // independent of the site-wide portal navigation (navigation_item /
      // PublicHeader.jsx). Each top-level item is either a plain link (uses
      // `href`) or opens a rich dropdown panel built from `columns` and/or a
      // featured block. All links are typed URLs.
      align: 'left', // left | center | right
      fullBleed: false,
      barBackgroundColor: '#ffffff',
      barTextColor: '#0f172a',
      panelBackgroundColor: '#ffffff',
      panelTextColor: '#0f172a',
      accentColor: '#9333ea',
      labelFontSize: 14,
      items: [
        {
          label: 'Home',
          hasPanel: false,
          href: '/Home',
          openInNewTab: false,
          columns: [],
          featuredImage: '',
          featuredAlt: '',
          featuredTitle: '',
          featuredText: '',
          featuredHref: '',
          featuredOpenInNewTab: false,
        },
        {
          label: 'Products',
          hasPanel: true,
          href: '',
          openInNewTab: false,
          columns: [
            {
              heading: 'Popular',
              links: [
                { label: 'Overview', href: '/products', description: 'See everything we offer', openInNewTab: false },
                { label: 'Pricing', href: '/pricing', description: 'Plans for every team', openInNewTab: false },
              ],
            },
            {
              heading: 'Resources',
              links: [
                { label: 'Guides', href: '/guides', description: 'Step-by-step help', openInNewTab: false },
                { label: 'Blog', href: '/blog', description: 'News and updates', openInNewTab: false },
              ],
            },
          ],
          featuredImage: '',
          featuredAlt: '',
          featuredTitle: 'Featured',
          featuredText: 'Highlight something special here.',
          featuredHref: '',
          featuredOpenInNewTab: false,
        },
        {
          label: 'Contact',
          hasPanel: false,
          href: '/Contact',
          openInNewTab: false,
          columns: [],
          featuredImage: '',
          featuredAlt: '',
          featuredTitle: '',
          featuredText: '',
          featuredHref: '',
          featuredOpenInNewTab: false,
        },
      ],
    },
  },
  [BLOCK_TYPES.COUNTDOWN]: {
    name: 'Countdown',
    geom: { w: 480, h: 160 },
    style: { background: 'transparent', borderWidth: 0, borderRadius: 8 },
    content: {
      // ISO-ish local datetime string (value of an <input type="datetime-local">),
      // e.g. "2026-12-31T23:59". Interpreted in the viewer's local timezone,
      // matching how the inspector's datetime-local input captures it.
      targetDate: '',
      // Optional link to an event. When set, the target is read from the
      // event's start_date instead of the manual targetDate above, keeping the
      // countdown accurate if the event date changes. eventSlug is preferred
      // (public-stable); eventId is the legacy fallback.
      eventSlug: '',
      eventId: '',
      showDays: true,
      showHours: true,
      showMinutes: true,
      showSeconds: true,
      daysLabel: 'Days',
      hoursLabel: 'Hours',
      minutesLabel: 'Minutes',
      secondsLabel: 'Seconds',
      finishedMessage: "Time's up!",
      alignment: 'center',
      // Visual preset for the units: 'plain' renders bare numbers + labels;
      // 'boxed' wraps each unit in a card using shared block tokens. Existing
      // countdowns (no value persisted) fall back to 'plain' — no visual change.
      presetStyle: 'plain',
      // Show ':' colon separators between adjacent units.
      showSeparators: false,
      numberColor: 'var(--cb-color-primary, #0f172a)',
      labelColor: '',
      // Boxed preset: background + border of each unit card. Empty strings fall
      // back to shared block tokens so tenant branding flows through.
      boxBackground: '',
      boxBorderColor: '',
      numberFontSize: 40,
      labelFontSize: 13,
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
  [BLOCK_TYPES.EVENT_SESSIONS]: {
    name: 'Event sessions',
    geom: { w: 800, h: 600 },
    style: { background: '#ffffff', borderWidth: 1, borderRadius: 8 },
    content: {
      eventId: '',
      emptyText: 'No sessions have been published for this event yet.',
    },
  },
  [BLOCK_TYPES.EVENT_CAROUSEL]: {
    name: 'Event carousel',
    geom: { w: 800, h: 400 },
    style: { background: '#ffffff', borderWidth: 1, borderRadius: 8 },
    content: {
      eventIds: [],
      ctaLabel: 'Find out more',
      showSummary: true,
      showDate: true,
      imageSide: 'left',
      imageAspect: '4/3',
      autoplay: false,
      autoplayMs: 5000,
      showArrows: true,
      showIndicators: true,
      emptyText: 'Pick one or more events in the inspector.',
    },
  },
  [BLOCK_TYPES.SPEAKER_CAROUSEL]: {
    name: 'Speaker carousel',
    geom: { w: 800, h: 420 },
    style: { background: '#ffffff', borderWidth: 1, borderRadius: 8 },
    content: {
      eventId: '',
      ctaLabel: 'See all speakers',
      ctaMode: 'popup',
      ctaHref: '',
      speakersPerView: 1,
      showJobTitle: true,
      showOrganization: true,
      autoplay: true,
      autoplayMs: 5000,
      showArrows: true,
      showIndicators: true,
      transition: 'slide',
      transitionMs: 400,
      pauseOnHover: false,
      emptyText: 'Pick an event with assigned speakers in the inspector.',
    },
  },
  [BLOCK_TYPES.SPEAKER_GRID]: {
    name: 'Speaker grid',
    geom: { w: 800, h: 520 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      eventId: '',
      columns: { desktop: 4, tablet: 2, mobile: 1 },
      gap: 16,
      paginate: false,
      rowsPerPage: 2,
      showJobTitle: true,
      showOrganization: true,
      emptyText: 'Pick an event with assigned speakers in the inspector.',
    },
  },
  [BLOCK_TYPES.SPONSOR_GRID]: {
    name: 'Sponsor grid',
    geom: { w: 800, h: 520 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      eventId: '',
      categoryIds: [],
      categoryOrder: [],
      columns: { desktop: 4, tablet: 2, mobile: 1 },
      gap: 16,
      showDescription: true,
      showSponsorDetail: false,
      showCategoryHeadings: true,
      centerAlign: false,
      emptyText: 'Pick an event with assigned sponsors in the inspector.',
      emptyCatMessage: '',
      emptyCatCtaLabel: '',
      emptyCatCtaHref: '',
    },
  },
  [BLOCK_TYPES.SPONSOR_CAROUSEL]: {
    name: 'Sponsor carousel',
    geom: { w: 800, h: 420 },
    style: { background: '#ffffff', borderWidth: 1, borderRadius: 8 },
    content: {
      eventId: '',
      categoryIds: [],
      sponsorsPerView: 3,
      gap: 16,
      innerPaddingTop: 16,
      innerPaddingRight: 32,
      innerPaddingBottom: 16,
      innerPaddingLeft: 32,
      showDescription: true,
      showSponsorDetail: false,
      autoplay: true,
      autoplayMs: 5000,
      showArrows: true,
      showIndicators: true,
      transition: 'slide',
      transitionMs: 400,
      pauseOnHover: false,
      centerAlign: false,
      fullBleed: false,
      emptyText: 'Pick an event with assigned sponsors in the inspector.',
      emptyCatMessage: '',
      emptyCatCtaLabel: '',
      emptyCatCtaHref: '',
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
      paginate: false,
      searchEnabled: false,
      searchPlaceholder: 'Search resources…',
      resourceType: '',
      tag: '',
      columns: { desktop: 3, tablet: 2, mobile: 1 },
      gap: 16,
      emptyText: 'No resources available.',
      cardTitleTypographyStyleId: '',
      cardDescriptionTypographyStyleId: '',
      ctaVariant: 'outline',
      ctaAlign: 'left',
    },
  },
  [BLOCK_TYPES.FORM_EMBED]: {
    name: 'Form embed',
    geom: { w: 640, h: 480 },
    style: { background: 'transparent', borderWidth: 0 },
    // fullBleed defaults to false and bgType to 'color' so existing form
    // embeds (which carry none of these fields) render byte-identically to
    // today: transparent background, no full-bleed. The overlay/gradient
    // fields mirror the Section element's background schema and are only
    // consulted when bgType is 'image'/'gradient' respectively. As with
    // Section, `gradientStops` is deliberately NOT seeded here.
    content: {
      formSlug: '',
      mode: 'inline', // inline | iframe | link
      title: '',
      ctaLabel: 'Open form',
      fullBleed: false,
      bgType: 'color',
      bgImageUrl: '',
      overlayType: 'solid',
      overlayBlendMode: 'normal',
      overlayColor: '#000000',
      overlayOpacity: 0.4,
      overlayFromColor: '#000000',
      overlayFromOpacity: 0.6,
      overlayToColor: '#000000',
      overlayToOpacity: 0,
      overlayAngle: 180,
      overlayCenterColor: '#000000',
      overlayCenterOpacity: 0,
      overlayEdgeColor: '#000000',
      overlayEdgeOpacity: 0.6,
      fontFamily: '', // unset = embedded form's default typography
      fontSize: null, // unset = embedded form's default base text size (px)
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
  [BLOCK_TYPES.CARD_DECK]: {
    name: 'Card deck',
    geom: { w: 800, h: 520 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      cardIds: [],
      title: '',
      headingLevel: 2,
      columns: { desktop: 3, tablet: 2, mobile: 1 },
      gap: 24,
      showImage: true,
      showDescription: true,
      showButton: true,
      emptyText: 'Select cards in the inspector.',
    },
  },
  [BLOCK_TYPES.WALL_OF_FAME]: {
    name: 'Wall of Fame',
    geom: { w: 800, h: 560 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      sectionId: '',
      categoryId: null,
      columns: { desktop: 3, tablet: 2, mobile: 1 },
      gap: 24,
      showPhoto: true,
      showJobTitle: true,
      showBioSnippet: false,
      fullBleed: false,
      emptyText: 'Select a Wall of Fame section in the inspector.',
    },
  },
  [BLOCK_TYPES.GALLERY]: {
    name: 'Photo Gallery',
    geom: { w: 800, h: 560 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      gallerySlug: '',
      heading: '',
      headingLevel: 2,
      displayMode: 'grid',
      columns: { desktop: 3, tablet: 2, mobile: 1 },
      gap: 16,
      pageSize: 12,
      emptyText: 'Select a photo gallery in the inspector.',
    },
  },
  // Card Flip Grid — a static, inline-authored block (cards live in
  // block.content, like Hero CTAs; never fetched from a data source). Each
  // card flips on click to reveal its back text, mirroring the Wall of Fame
  // 3D flip. `columns` × `rowsPerPage` drives pagination; `shape` is
  // square | rectangular | circular, and `cardHeight` only applies when
  // shape === 'rectangular' (square/circular cards are 1:1).
  [BLOCK_TYPES.CARD_FLIP_GRID]: {
    name: 'Card Flip Grid',
    geom: { w: 800, h: 520 },
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      cards: [
        { image: '', imageAlt: '', title: 'Card one', summary: 'A short summary shown on the back of the card.', content: '<p>The full content for the first card. Add rich text here, then it shows in a pop-up when the visitor clicks View more.</p>', backText: '' },
        { image: '', imageAlt: '', title: 'Card two', summary: 'A short summary shown on the back of the card.', content: '<p>The full content for the second card.</p>', backText: '' },
        { image: '', imageAlt: '', title: 'Card three', summary: 'A short summary shown on the back of the card.', content: '<p>The full content for the third card.</p>', backText: '' },
      ],
      columns: { desktop: 3, tablet: 2, mobile: 1 },
      rowsPerPage: 2,
      gap: 16,
      shape: 'square', // square | rectangular | circular
      cardHeight: 320, // only used when shape === 'rectangular'
      cornerRadius: 8, // px; ignored when shape === 'circular' (forced round)
      flipDuration: 0.7, // seconds for the flip animation
      titleColor: '#ffffff',
      titleSize: 16, // px; front title font size
      titleTypographyStyleId: '', // optional tenant typography style for the front title font
      titlePosition: 'on', // on | above | below — where the front title sits relative to the image (works for all shapes, including circular)
      titleAlignment: 'left', // left | center | right — horizontal alignment of the front title in every position/shape
      summaryTypographyStyleId: '', // optional tenant typography style for the back summary
      showTitleOverlay: true, // hide to drop the gradient behind the title (only applies when titlePosition === 'on')
      overlayStrength: 0.72, // 0-1 opacity of the front overlay wash
      overlayColor: '#000000', // colour of the front overlay gradient (fades to transparent)
      overlayStyle: 'fade', // fade = gradient to transparent | solid = full coverage uniform wash
      backBgType: 'color', // color | gradient
      backBgColor: 'var(--cb-color-surface, #ffffff)',
      // Gradient back: only consulted when backBgType === 'gradient'. Kept on
      // dedicated back* keys so they never collide with the solid backBgColor.
      backGradientType: 'linear', // linear | radial
      backGradientFromColor: '#3b82f6',
      backGradientToColor: '#1e3a8a',
      backGradientAngle: 180, // deg; linear only
      backTextColor: 'var(--cb-color-on-surface, #0f172a)',
    },
  },
};

BLOCK_DEFAULTS[BLOCK_TYPES.SYMBOL] = {
  name: 'Symbol',
  geom: { w: 600, h: 240 },
  style: { background: 'transparent', borderWidth: 0 },
  content: { symbolId: '', symbolName: '' },
};

// Login form block: fixed 448×520 card — position-only (no resize handles).
BLOCK_DEFAULTS[BLOCK_TYPES.LOGIN_FORM] = {
  name: 'Login Form',
  geom: { w: 448, h: 520 },
  style: { background: 'transparent', borderWidth: 0 },
  content: {},
};

// Search input block: a styled search field that reuses the public search
// endpoint. Renders identically in the editor preview and the published page.
// `includeOutsideMicrosite` only takes effect on microsite pages (default ON =
// tenant-wide results; OFF = results limited to the current microsite).
BLOCK_DEFAULTS[BLOCK_TYPES.SEARCH_INPUT] = {
  name: 'Search Input',
  geom: { w: 360, h: 48 },
  style: { background: 'transparent', borderWidth: 0, borderRadius: 8 },
  content: {
    placeholder: 'Search…',
    size: 'md', // sm | md | lg
    backgroundColor: '#ffffff',
    textColor: '#0f172a',
    borderColor: '#cbd5e1',
    borderWidth: 1,
    showIcon: true,
    includeOutsideMicrosite: true,
  },
};

// Hero Carousel block: slide-based hero with per-slide backgrounds, overlays,
// rich-text headings, CTA buttons, and configurable carousel playback.
BLOCK_DEFAULTS[BLOCK_TYPES.HERO_CAROUSEL] = {
  name: 'Hero Carousel',
  geom: { w: 800, h: 500 },
  style: { background: 'var(--cb-color-primary, #0f172a)', borderWidth: 0, borderRadius: 0 },
  content: {
    slides: [
      {
        id: 'slide-default-1',
        headerText: '<p>Your Heading Here</p>',
        subheadingText: '',
        contentText: '',
        ctaText: '',
        ctaLink: '',
        ctaStyle: '',
        backgroundImage: '',
        overlayColor: '#000000',
        overlayOpacity: 40,
        imageFit: 'cover',
      },
    ],
    header_font_family: 'Poppins',
    header_font_size: 48,
    header_color: 'var(--cb-color-on-primary, #ffffff)',
    header_font_weight: 700,
    header_letter_spacing: 0,
    header_line_height: 1.2,
    subheading_font_family: 'Poppins',
    subheading_font_size: 24,
    subheading_color: 'var(--cb-color-on-primary, #ffffff)',
    subheading_font_weight: 400,
    subheading_letter_spacing: 0,
    subheading_line_height: 1.5,
    content_font_family: 'Poppins',
    content_font_size: 16,
    content_color: 'var(--cb-color-on-primary, #ffffff)',
    content_font_weight: 400,
    content_letter_spacing: 0,
    content_line_height: 1.6,
    text_alignment: 'center',
    height_type: 'custom',
    custom_height: 500,
    auto_min_height: 400,
    padding_vertical: 60,
    padding_horizontal: 16,
    text_offset_x: 0,
    text_offset_y: 0,
    mobile_text_offset_x: 0,
    mobile_text_offset_y: 0,
    autoplayInterval: 5,
    transitionEffect: 'fade',
    transitionDuration: 700,
    pauseOnHover: true,
    showArrows: true,
    showDots: true,
    fullBleed: false,
  },
};

export function getBlockDefaults(type) {
  return BLOCK_DEFAULTS[type] || BLOCK_DEFAULTS[BLOCK_TYPES.BOX];
}

// Task #1609 — measure the rendered extent of a symbol's content at a given
// breakpoint, in the symbol's OWN local coordinate space. Symbols are
// authored with their selection's top-left translated to the origin (see the
// Symbols dialog), so the extent measured from (0,0) tightly wraps the
// content. Used to fit a symbol instance's bounding box to what is actually
// drawn instead of leaving it at the placeholder/default size. Returns null
// when the symbol has no visible children at this breakpoint.
export function symbolContentExtent(symbolDesign, breakpoint = 'desktop') {
  if (!symbolDesign) return null;
  const kids = getRootChildren(symbolDesign);
  let maxRight = 0;
  let maxBottom = 0;
  let any = false;
  for (const c of kids) {
    const g = resolveBlockAtBreakpoint(c, breakpoint);
    if (g.hidden) continue;
    any = true;
    maxRight = Math.max(maxRight, (g.x || 0) + (g.w || 0));
    maxBottom = Math.max(maxBottom, (g.y || 0) + (g.h || 0));
  }
  if (!any) return null;
  return { w: Math.max(10, Math.round(maxRight)), h: Math.max(10, Math.round(maxBottom)) };
}

// Phase 7 — Resolve symbol references inside a canvas design. Each `symbol`
// block keeps its own geometry (x/y/w/h on the host page) but its visual
// content comes from the referenced canvas_symbol design document. The
// renderer calls this to splice symbol children into the page at render
// time. Resolution is purely a read transform — the underlying page design
// stays unchanged so authors can unlink symbols later.
export function resolveSymbolsInDesign(design, symbolsById) {
  if (!design || !symbolsById || symbolsById.size === 0) return design;
  const d = normalizeCanvasDesign(design);
  const sections = d.root.sections.map((section) => ({
    ...section,
    children: section.children.map((b) => {
      if (b.type !== BLOCK_TYPES.SYMBOL) return b;
      const sym = symbolsById.get(b?.content?.symbolId);
      if (!sym || !sym.design) {
        return { ...b, name: b.name || 'Missing symbol' };
      }
      // Pull the symbol's first-section children and re-key their ids so
      // multiple instances of the same symbol don't collide. Geometry is
      // preserved verbatim from the symbol design.
      const symDesign = normalizeCanvasDesign(sym.design);
      // Translate each child by the host symbol block's per-breakpoint
      // origin so the symbol renders at its placed position on the host
      // page. Without this, every symbol instance would render at
      // top-left (its own local origin) and overlap with the others.
      const hostBp = b.bp || {};
      const symChildren = getRootChildren(symDesign).map((c, i) => {
        const cBp = c.bp || {};
        const nextBp = {};
        for (const key of ['desktop', 'tablet', 'mobile']) {
          const hostFrame = hostBp[key] || hostBp.desktop || {};
          const childFrame = cBp[key] || cBp.desktop || {};
          if (!childFrame) continue;
          nextBp[key] = {
            ...childFrame,
            x: (childFrame.x || 0) + (hostFrame.x || 0),
            y: (childFrame.y || 0) + (hostFrame.y || 0),
            hidden: childFrame.hidden ?? hostFrame.hidden ?? false,
          };
        }
        return {
          ...c,
          id: `${b.id}__${c.id || i}`,
          locked: true,
          bp: nextBp,
        };
      });
      // Fit the host symbol block's box to the symbol's rendered content per
      // breakpoint (Task #1609). The host position (x/y) is preserved; only
      // width/height are derived from the content extent so any consumer that
      // reads the host geometry sees a box that wraps what is drawn. This is
      // a read-time transform — the persisted page design is untouched. The
      // public renderer splices __symbolChildren as siblings and ignores the
      // host box, so its output is unchanged.
      //
      // Fit ALL breakpoints, even ones the instance never overrode: symbol
      // content can resolve to a different extent at tablet/mobile, so we
      // write a display-only {w,h} for each. We only ever set w/h on the
      // breakpoint frame, never x/y, so resolveBlockAtBreakpoint still
      // cascades x/y from desktop for breakpoints that had no explicit frame.
      const fittedBp = { ...hostBp };
      for (const key of ['desktop', 'tablet', 'mobile']) {
        const ext = symbolContentExtent(symDesign, key);
        if (!ext) continue;
        fittedBp[key] = { ...(hostBp[key] || {}), w: ext.w, h: ext.h };
      }
      // Wrap symbol children in a single transparent "container" block so
      // the host geometry (x/y/w/h) still controls placement. We do this
      // by emitting a synthetic section-style block that contains the
      // symbol's children translated into its local coordinate space.
      return {
        ...b,
        bp: Object.keys(fittedBp).length > 0 ? fittedBp : b.bp,
        // Keep host block geometry & a11y. Replace content children for the
        // renderer to pick up.
        __symbolChildren: symChildren,
      };
    }),
  }));
  return { ...d, root: { ...d.root, sections } };
}

// Build a CSS variable map from a tenant theme object. Used by the renderer
// to inject :root-scoped overrides on the canvas page wrapper.
export function buildThemeCssVars(theme) {
  if (!theme || typeof theme !== 'object') return '';
  const lines = [];
  const colors = theme.colors || {};
  for (const [k, v] of Object.entries(colors)) {
    if (!v) continue;
    // Accept either H S% L% or hex / rgb — pass through as-is.
    lines.push(`--cb-color-${k}: ${v};`);
  }
  const typography = theme.typography || {};
  for (const [k, v] of Object.entries(typography)) {
    if (!v) continue;
    lines.push(`--cb-font-${k}: ${v};`);
  }
  const spacing = theme.spacing || {};
  for (const [k, v] of Object.entries(spacing)) {
    if (v == null || v === '') continue;
    lines.push(`--cb-space-${k}: ${typeof v === 'number' ? `${v}px` : v};`);
  }
  return lines.join('\n');
}

export function createEmptyCanvasDesign(version = CANVAS_DESIGN_VERSION) {
  // Rollout aid (Task #2678): allow callers to request a v2 (auto-layout/flow)
  // empty design so a new page can start directly in flow mode. Accepts either
  // the numeric flow version or the string 'v2' for convenience. Any other
  // value falls through to the existing v1 (absolute-positioning) default, so
  // the default behaviour is unchanged.
  if (version === CANVAS_FLOW_VERSION || version === 'v2') {
    return createFlowDesign();
  }
  return {
    version: CANVAS_DESIGN_VERSION,
    root: {
      background: null,
      // Task #1425: layer groups. A lightweight registry of
      // { id, name, collapsed }; member blocks reference a group via
      // `block.groupId`. Groups are purely organisational — z-order,
      // geometry and the public renderer are unaffected.
      groups: [],
      // Task #1665: editor-only ruler guides. Two arrays of stage-coordinate
      // positions — `vertical` are x-offsets, `horizontal` are y-offsets.
      // Guides are an authoring aid (drag-out from the rulers, snap blocks to
      // them); they are NEVER read by the public renderer, which only walks
      // `root.sections`.
      guides: { vertical: [], horizontal: [] },
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

// ===========================================================================
// Task #2558 — Flow (auto-layout) model, version 2.
//
// A flow design is an ordered tree of nodes. Every node has the same v1 leaf
// shape (id/type/name/anchorId/locked/groupId/fullWidth/style/a11y/content/bp)
// PLUS flow-model fields:
//   - layoutMode : 'flow' | 'free'   (containers only)
//   - flow       : spacing/sizing expressed as gaps/margins, NOT coordinates
//   - responsive : per-breakpoint order/visibility/column overrides
//   - children   : array of child nodes (containers only)
//
// `bp` (absolute per-breakpoint geometry) is RETAINED and is the source of
// truth for a node's placement ONLY when it is inside a `free` container. In
// flow containers, `bp` is ignored for position (position is derived) but a
// leaf may pin its own height via `flow.heightMode:'fixed'` + `flow.height`.
//
// These helpers are additive and never touch the v1 path — `normalizeCanvasDesign`
// only routes into the flow normalizer when `isFlowDesign()` is true.
// ===========================================================================

export function isFlowDesign(design) {
  if (!design || typeof design !== 'object') return false;
  if (design.version === CANVAS_FLOW_VERSION) return true;
  return design.root && typeof design.root === 'object' && design.root.layout === 'flow';
}

function defaultFlowProps() {
  return {
    // Gap between a container's children (px). Ignored on leaves.
    gap: 24,
    // Inner padding of a container (px). On a leaf these are ignored in favour
    // of style.padding*, kept here only so the shape is uniform.
    padTop: 0,
    padRight: 0,
    padBottom: 0,
    padLeft: 0,
    // Cross-axis alignment of children (start|center|end|stretch).
    align: 'stretch',
    // Main-axis distribution of children (start|center|end|between|around).
    justify: 'start',
    // This node's flex-grow within a Row (0 = don't grow).
    grow: 0,
    // Preferred main-size within a Row: a px number, a `'<n>%'` string, or null
    // (equal split). Sections/leaves in a vertical stack ignore this.
    basis: null,
    // Outer vertical margins (px) added above/below this node in its parent.
    marginTop: 0,
    marginBottom: 0,
    // Height resolution: 'auto' = derived from measured/child content;
    // 'fixed' = use `flow.height` (px). Leaves like spacer/divider/hero use
    // 'fixed'; text/accordion use 'auto' so editing content reflows.
    heightMode: 'auto',
    height: null,
    // Optional centered content max-width for a container (px), null = full.
    maxWidth: null,
  };
}

const FLOW_ALIGN = new Set(['start', 'center', 'end', 'stretch']);
const FLOW_JUSTIFY = new Set(['start', 'center', 'end', 'between', 'around']);

function normalizeFlowProps(flow) {
  const f = flow && typeof flow === 'object' ? flow : {};
  const d = defaultFlowProps();
  const numOr = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  // Nullable numeric: null/undefined/'' stay null (Number(null) === 0 would
  // otherwise flip a null height/maxWidth to 0 on re-normalize — breaking
  // idempotency).
  const numOrNull = (v) =>
    v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
  let basis = null;
  if (typeof f.basis === 'number' && Number.isFinite(f.basis)) basis = f.basis;
  else if (typeof f.basis === 'string' && f.basis.trim()) basis = f.basis.trim();
  return {
    gap: numOr(f.gap, d.gap),
    padTop: numOr(f.padTop, d.padTop),
    padRight: numOr(f.padRight, d.padRight),
    padBottom: numOr(f.padBottom, d.padBottom),
    padLeft: numOr(f.padLeft, d.padLeft),
    align: FLOW_ALIGN.has(f.align) ? f.align : d.align,
    justify: FLOW_JUSTIFY.has(f.justify) ? f.justify : d.justify,
    grow: numOr(f.grow, d.grow),
    basis,
    marginTop: numOr(f.marginTop, d.marginTop),
    marginBottom: numOr(f.marginBottom, d.marginBottom),
    heightMode: f.heightMode === 'fixed' ? 'fixed' : 'auto',
    height: numOrNull(f.height),
    maxWidth: numOrNull(f.maxWidth),
  };
}

// Per-breakpoint flow overrides. `hidden` toggles visibility, `order` reorders
// within the parent (lower first; null = source order), `columns` overrides a
// Row's column count, `stack` forces a Row to stack vertically.
function normalizeResponsiveBp(o) {
  const s = o && typeof o === 'object' ? o : {};
  const out = {};
  if (typeof s.hidden === 'boolean') out.hidden = s.hidden;
  if (Number.isFinite(Number(s.order))) out.order = Number(s.order);
  if (Number.isFinite(Number(s.columns))) out.columns = Number(s.columns);
  if (typeof s.stack === 'boolean') out.stack = s.stack;
  return out;
}

function normalizeResponsive(responsive) {
  const r = responsive && typeof responsive === 'object' ? responsive : {};
  return {
    tablet: normalizeResponsiveBp(r.tablet),
    mobile: normalizeResponsiveBp(r.mobile),
  };
}

// Build a fully-formed flow node (leaf or container) from a type + overrides.
// Reuses createBlock for the shared leaf shape so styling/content defaults and
// the bp frame stay identical to v1 blocks.
export function createFlowNode(type = BLOCK_TYPES.BOX, overrides = {}) {
  const base = createBlock(type, overrides);
  const isContainer = isFlowContainerType(type);
  const defaultMode = type === BLOCK_TYPES.GROUP ? LAYOUT_MODES.FREE : LAYOUT_MODES.FLOW;
  const node = {
    ...base,
    layoutMode: isContainer
      ? (overrides.layoutMode === LAYOUT_MODES.FREE || overrides.layoutMode === LAYOUT_MODES.FLOW
        ? overrides.layoutMode
        : defaultMode)
      : LAYOUT_MODES.FLOW,
    flow: normalizeFlowProps(overrides.flow),
    responsive: normalizeResponsive(overrides.responsive),
  };
  if (isContainer) {
    node.children = Array.isArray(overrides.children)
      ? overrides.children.map((c) => normalizeFlowNode(c)).filter(Boolean)
      : [];
  }
  return node;
}

export function createFlowSection(overrides = {}) {
  return createFlowNode(BLOCK_TYPES.SECTION, { layoutMode: LAYOUT_MODES.FLOW, ...overrides });
}

export function createRow(overrides = {}) {
  return createFlowNode(BLOCK_TYPES.ROW, { layoutMode: LAYOUT_MODES.FLOW, ...overrides });
}

export function createFreeGroup(overrides = {}) {
  return createFlowNode(BLOCK_TYPES.GROUP, { layoutMode: LAYOUT_MODES.FREE, ...overrides });
}

export function createFlowDesign() {
  return {
    version: CANVAS_FLOW_VERSION,
    root: {
      background: null,
      groups: [],
      guides: { vertical: [], horizontal: [] },
      layout: 'flow',
      sections: [createFlowSection({ name: 'Section' })],
    },
  };
}

// Normalize one flow node (recursive). Reuses normalizeBlock for the leaf
// shape (so the CARD inset shim and __symbolChildren preservation keep working)
// then layers on the flow-model fields. Containers recurse into children.
function normalizeFlowNode(node) {
  if (!node || typeof node !== 'object') return null;
  const type = node.type || BLOCK_TYPES.BOX;
  const leaf = normalizeBlock(node);
  if (!leaf) return null;
  const isContainer = isFlowContainerType(type);
  const defaultMode = type === BLOCK_TYPES.GROUP ? LAYOUT_MODES.FREE : LAYOUT_MODES.FLOW;
  const out = {
    ...leaf,
    layoutMode: isContainer
      ? (node.layoutMode === LAYOUT_MODES.FREE || node.layoutMode === LAYOUT_MODES.FLOW
        ? node.layoutMode
        : defaultMode)
      : LAYOUT_MODES.FLOW,
    flow: normalizeFlowProps(node.flow),
    responsive: normalizeResponsive(node.responsive),
  };
  if (isContainer) {
    out.children = Array.isArray(node.children)
      ? node.children.map(normalizeFlowNode).filter(Boolean)
      : [];
  }
  return out;
}

// Normalize a whole flow (v2) design. Top-level sections must be containers;
// a non-container top-level node is wrapped defensively is not done here — the
// converter (Step 4) is responsible for producing well-formed section roots.
export function normalizeFlowDesign(design) {
  if (!design || typeof design !== 'object') return createFlowDesign();
  const root = design.root && typeof design.root === 'object' ? design.root : {};
  let sections = Array.isArray(root.sections) && root.sections.length > 0
    ? root.sections.map(normalizeFlowNode).filter(Boolean)
    : [];
  if (sections.length === 0) sections = [createFlowSection({ name: 'Section' })];

  // Preserve the layer-group registry + editor guides exactly as the v1 path
  // does (they remain valid organisational/authoring aids in the flow model).
  const groups = Array.isArray(root.groups)
    ? root.groups.map(normalizeGroup).filter(Boolean)
    : [];
  const guides = normalizeGuides(root.guides);

  return {
    version: CANVAS_FLOW_VERSION,
    root: {
      background: root.background ?? null,
      groups,
      guides,
      layout: 'flow',
      sections,
    },
  };
}

// DFS walk over every node in a flow design (sections first, then descendants).
// `fn(node, { parent, depth, index })` is called for each node.
export function forEachFlowNode(design, fn) {
  const walk = (node, ctx) => {
    fn(node, ctx);
    if (Array.isArray(node.children)) {
      node.children.forEach((child, index) => walk(child, { parent: node, depth: ctx.depth + 1, index }));
    }
  };
  const sections = design?.root?.sections || [];
  sections.forEach((section, index) => walk(section, { parent: null, depth: 0, index }));
}

export function getFlowSections(design) {
  return design?.root?.sections || [];
}

// Task #2682 — append a flow node as the LAST child of a section so the flow
// engine lays it out (a dropped element must never become a sibling of the
// sections). `sectionId` selects the target section; when it is null or does
// not match, the node lands in the FIRST section — the same section the
// builder's shared edit handlers (getRootChildren/replaceChildren) operate on,
// so the node stays selectable and editable. The whole design is re-run through
// normalizeFlowDesign so the result is a well-formed, idempotent v2 document
// (the appended node is normalized in place) and persists through save/reopen.
export function insertFlowNode(design, node, options = {}) {
  if (!node || typeof node !== 'object') return design;
  const d = normalizeFlowDesign(design);
  const sections = d.root.sections.map((s) => ({
    ...s,
    children: Array.isArray(s.children) ? [...s.children] : [],
  }));
  if (sections.length === 0) return d;
  const { sectionId = null } = options;
  let idx = sectionId ? sections.findIndex((s) => s.id === sectionId) : -1;
  if (idx < 0) idx = 0;
  sections[idx].children.push(node);
  return normalizeFlowDesign({ ...d, root: { ...d.root, sections } });
}

// Leaf block types whose height is content-driven (measured at render time)
// rather than pinned. Mirrors the registry `autoHeight: true` flags — kept here
// in the React-free data layer so the v1->v2 converter (which also runs on the
// server, without the JSX registry) knows which leaves must flow-size.
export const AUTO_HEIGHT_LEAF_TYPES = new Set([
  BLOCK_TYPES.TEXT,
  BLOCK_TYPES.ACCORDION,
  BLOCK_TYPES.CARD,
]);

// ===========================================================================
// Task #2570 — v1 (absolute) -> v2 (flow) converter.
//
// A v1 design positions every block absolutely inside a single root section.
// The flow model stacks children vertically and lays out side-by-side blocks
// as Row columns. A perfect 2-D -> 1-D conversion is not generally possible,
// so this converter makes a faithful, deterministic best-effort:
//   - Blocks are read from the v1 root's first section (the flat block list).
//   - They are clustered into vertical BANDS: blocks whose desktop vertical
//     extents substantially overlap belong to the same band (i.e. they sat
//     side-by-side on the same visual row).
//   - A single-block band becomes a stacked flow leaf. A multi-block band
//     becomes a Row whose columns (left-to-right) carry each block's width as
//     `flow.basis`, so relative widths are preserved.
//   - Vertical rhythm is preserved via per-band `flow.marginTop` (the gap from
//     the previous band's bottom); the section gap is 0 so margins are exact.
//   - Auto-height leaves (text/accordion/card) flow-size; everything else pins
//     its height to the authored desktop height.
//
// The result is run through `normalizeFlowDesign` so it is a well-formed,
// idempotent v2 document. Converting an already-v2 design is a no-op
// (normalize only). This is React-free so the admin opt-in endpoint can import
// and run it server-side.
// ===========================================================================

// Fraction of the shorter block height that two blocks' vertical extents must
// overlap by to be treated as the same visual row (side-by-side columns).
const FLOW_BAND_OVERLAP_RATIO = 0.5;

function flowLeafFromBlock(block, { marginTop = 0, basis = null } = {}) {
  const geom = resolveBlockAtBreakpoint(block, 'desktop');
  const isAuto = AUTO_HEIGHT_LEAF_TYPES.has(block.type);
  const height = Number.isFinite(geom.h) ? geom.h : null;
  return normalizeFlowNode({
    ...block,
    layoutMode: LAYOUT_MODES.FLOW,
    flow: {
      ...(block.flow && typeof block.flow === 'object' ? block.flow : {}),
      marginTop: Math.max(0, Math.round(marginTop)),
      basis: basis == null ? null : Math.round(basis),
      heightMode: isAuto ? 'auto' : 'fixed',
      height: isAuto ? null : height,
    },
    responsive: {},
  });
}

export function convertDesignToFlow(design) {
  // Already a flow document: just normalize (idempotent no-op).
  if (isFlowDesign(design)) return normalizeFlowDesign(design);

  const v1 = normalizeCanvasDesign(design);
  const root = (v1 && v1.root) || {};
  const firstSection = Array.isArray(root.sections) ? root.sections[0] : null;
  const rawBlocks = (firstSection && Array.isArray(firstSection.children))
    ? firstSection.children
    : [];

  // Resolve desktop geometry once, then sort top-to-bottom then left-to-right
  // so band clustering and column order are deterministic. Desktop-hidden
  // blocks carry no meaningful position, so they are NOT band-clustered (they
  // would distort visible rows); they are preserved as standalone leaves at the
  // end so no authored content is lost by the migration.
  const resolved = rawBlocks.map((block) => {
    const g = resolveBlockAtBreakpoint(block, 'desktop');
    return {
      block,
      x: Number.isFinite(g.x) ? g.x : 0,
      y: Number.isFinite(g.y) ? g.y : 0,
      w: Number.isFinite(g.w) ? g.w : 0,
      h: Number.isFinite(g.h) ? g.h : 0,
      hidden: !!g.hidden,
    };
  });
  const items = resolved
    .filter((it) => !it.hidden)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const hiddenItems = resolved.filter((it) => it.hidden);

  // Cluster into vertical bands by overlap of vertical extents.
  const bands = [];
  for (const it of items) {
    const last = bands[bands.length - 1];
    if (last) {
      const overlap = Math.min(last.bottom, it.y + it.h) - Math.max(last.top, it.y);
      const minH = Math.max(1, Math.min(last.bottom - last.top, it.h));
      if (overlap > minH * FLOW_BAND_OVERLAP_RATIO) {
        last.items.push(it);
        last.top = Math.min(last.top, it.y);
        last.bottom = Math.max(last.bottom, it.y + it.h);
        continue;
      }
    }
    bands.push({ items: [it], top: it.y, bottom: it.y + it.h });
  }

  let prevBottom = null;
  const children = bands.map((band) => {
    const marginTop = prevBottom == null ? 0 : Math.max(0, band.top - prevBottom);
    prevBottom = band.bottom;

    if (band.items.length === 1) {
      return flowLeafFromBlock(band.items[0].block, { marginTop });
    }

    // Multi-block band -> Row of columns (left-to-right).
    const cols = [...band.items].sort((a, b) => a.x - b.x);
    const padLeft = Math.max(0, cols[0].x);
    // Uniform inter-column gap approximated from the first adjacent pair.
    let gap = 0;
    if (cols.length >= 2) {
      const between = cols[1].x - (cols[0].x + cols[0].w);
      gap = Number.isFinite(between) ? Math.max(0, Math.round(between)) : 0;
    }
    const rowChildren = cols.map((c) => flowLeafFromBlock(c.block, { basis: c.w }));
    return createRow({
      name: 'Row',
      flow: { marginTop: Math.max(0, Math.round(marginTop)), gap, padLeft, align: 'start' },
      children: rowChildren,
    });
  });

  // Preserve desktop-hidden blocks as trailing standalone leaves (their own
  // per-breakpoint hidden flags carry over via normalizeFlowNode) so no content
  // is dropped by the migration.
  for (const it of hiddenItems) {
    children.push(flowLeafFromBlock(it.block, { marginTop: 0 }));
  }

  const section = createFlowSection({
    name: (firstSection && firstSection.name) || 'Section',
    style: firstSection && firstSection.style ? firstSection.style : undefined,
    flow: { gap: 0 },
    children,
  });

  return normalizeFlowDesign({
    version: CANVAS_FLOW_VERSION,
    root: {
      background: root.background ?? null,
      groups: Array.isArray(root.groups) ? root.groups : [],
      guides: root.guides,
      layout: 'flow',
      sections: [section],
    },
  });
}

// Formats a Date into the "YYYY-MM-DDTHH:mm" string an <input type="datetime-local">
// expects, using the viewer's local timezone (matching how the Countdown
// inspector captures and the renderer parses the value).
export function toDatetimeLocalValue(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Merges default + override content, injecting per-type dynamic defaults that
// can't be expressed as static values. The Countdown block needs a target that
// is in the future *relative to when the block is dropped*, so a newly placed
// block immediately shows a live, ticking countdown rather than the
// "set a date" placeholder. Stored/duplicated blocks that already carry a
// targetDate are left untouched.
function buildBlockContent(type, defaultContent, overrideContent) {
  const merged = { ...(defaultContent || {}), ...(overrideContent || {}) };
  if (type === BLOCK_TYPES.COUNTDOWN && !merged.targetDate && !merged.eventSlug && !merged.eventId) {
    merged.targetDate = toDatetimeLocalValue(new Date(Date.now() + 24 * 60 * 60 * 1000));
  }
  return merged;
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
    // Task #1446: anchor links. An optional URL-safe slug that, when set,
    // renders as a real HTML `id` on the public block wrapper so it can be
    // an in-page scroll target. Defaults to '' (no anchor).
    anchorId: sanitizeAnchorId(overrides.anchorId || ''),
    locked: false,
    // Task #1425: group membership. Defaults to null; only set when a
    // block is explicitly placed into a group. New / duplicated / pasted
    // blocks therefore start ungrouped.
    groupId: overrides.groupId || null,
    fullWidth: !!overrides.fullWidth,
    style: { ...DEFAULT_STYLE, ...(defaults.style || {}), ...(overrides.style || {}) },
    a11y: { ...DEFAULT_A11Y, ...(defaults.a11y || {}), ...(overrides.a11y || {}) },
    content: deepClone(buildBlockContent(type, defaults.content, overrides.content)),
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
  // Task #2558 — route flow (v2) designs into the flow normalizer. The v1
  // path below is left byte-identical for existing (absolute-geometry) pages.
  if (isFlowDesign(design)) return normalizeFlowDesign(design);
  const root = design.root && typeof design.root === 'object' ? design.root : {};
  const sections = Array.isArray(root.sections) && root.sections.length > 0
    ? root.sections.map(normalizeSection)
    : [{ id: 'root-section', children: [] }];

  // Task #1425: normalize the group registry. Drop malformed entries, then
  // reconcile against actual block membership so the document is always
  // self-consistent: clear `groupId` references that point at a missing
  // group, and prune group entries that have no remaining members (e.g.
  // after their blocks were deleted). Legacy designs with no `groups` key
  // load unchanged with an empty registry.
  let groups = Array.isArray(root.groups)
    ? root.groups.map(normalizeGroup).filter(Boolean)
    : [];
  const groupIds = new Set(groups.map((g) => g.id));
  const memberCounts = {};
  for (const section of sections) {
    section.children = section.children.map((b) => {
      if (b.groupId && !groupIds.has(b.groupId)) return { ...b, groupId: null };
      if (b.groupId) memberCounts[b.groupId] = (memberCounts[b.groupId] || 0) + 1;
      return b;
    });
  }
  groups = groups.filter((g) => (memberCounts[g.id] || 0) > 0);

  const guides = normalizeGuides(root.guides);

  return {
    version: typeof design.version === 'number' ? design.version : CANVAS_DESIGN_VERSION,
    root: {
      background: root.background ?? null,
      groups,
      guides,
      sections,
    },
  };
}

// Task #1665 / #1667: normalize the editor-only ruler guides. Each guide is a
// `{ pos, locked }` object: `pos` is a finite, non-negative, rounded stage
// coordinate; `locked` is a boolean. Both axes are de-duplicated by `pos`
// (locked wins on a collision) and sorted ascending by `pos`.
//
// Back-compat: legacy designs stored plain `number[]` arrays (Task #1665).
// A bare number is coerced to `{ pos: n, locked: false }`, so old documents
// load unchanged. Designs with no `guides` key load with empty arrays.
function normalizeGuides(guides) {
  const clean = (arr) => {
    if (!Array.isArray(arr)) return [];
    const byPos = new Map();
    for (const entry of arr) {
      let pos;
      let locked = false;
      if (entry && typeof entry === 'object') {
        pos = Math.round(Number(entry.pos));
        locked = !!entry.locked;
      } else {
        pos = Math.round(Number(entry));
      }
      if (!Number.isFinite(pos) || pos < 0) continue;
      const existing = byPos.get(pos);
      if (existing) {
        existing.locked = existing.locked || locked;
      } else {
        byPos.set(pos, { pos, locked });
      }
    }
    return Array.from(byPos.values()).sort((a, b) => a.pos - b.pos);
  };
  const g = guides && typeof guides === 'object' ? guides : {};
  return { vertical: clean(g.vertical), horizontal: clean(g.horizontal) };
}

function normalizeGroup(group) {
  if (!group || typeof group !== 'object') return null;
  const id = typeof group.id === 'string' && group.id ? group.id : null;
  if (!id) return null;
  return {
    id,
    name: typeof group.name === 'string' && group.name.trim() ? group.name : 'Group',
    collapsed: !!group.collapsed,
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
  const normalized = {
    id: block.id || generateId(),
    type,
    name: block.name || defaults.name || 'Block',
    // Task #1446: preserve + re-sanitize the anchor id across normalization.
    anchorId: sanitizeAnchorId(block.anchorId || ''),
    locked: !!block.locked,
    // Task #1425: preserve group membership across normalization.
    groupId: typeof block.groupId === 'string' && block.groupId ? block.groupId : null,
    fullWidth: !!block.fullWidth,
    style: { ...DEFAULT_STYLE, ...(defaults.style || {}), ...(block.style || {}) },
    a11y: { ...DEFAULT_A11Y, ...(defaults.a11y || {}), ...(block.a11y || {}) },
    content: { ...(defaults.content || {}), ...(block.content || {}) },
    bp: {
      desktop,
      tablet: bp.tablet && typeof bp.tablet === 'object' ? bp.tablet : {},
      mobile: bp.mobile && typeof bp.mobile === 'object' ? bp.mobile : {},
    },
  };

  // CARD compatibility shim: cards used to carry their inset as outer block
  // padding (old default 16 all round), which also pushed the header image
  // off the edges. The card now keeps the image full-bleed and insets only
  // the text/CTA via `content.contentPadding`. For legacy cards saved with
  // outer padding but no `contentPadding`, move that padding inward and zero
  // the outer padding so they render with a single inset + full-bleed image.
  if (type === BLOCK_TYPES.CARD) {
    const savedContentPadding = block.content && block.content.contentPadding;
    const savedStyle = block.style || {};
    const legacyOuter = Math.max(
      Number(savedStyle.paddingTop) || 0,
      Number(savedStyle.paddingRight) || 0,
      Number(savedStyle.paddingBottom) || 0,
      Number(savedStyle.paddingLeft) || 0,
    );
    if (savedContentPadding == null && legacyOuter > 0) {
      normalized.content.contentPadding = legacyOuter;
      normalized.style = {
        ...normalized.style,
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
      };
    }
  }

  // Task #1675: preserve resolved symbol children across re-normalization.
  // resolveSymbolsInDesign attaches a non-standard __symbolChildren array onto
  // symbol blocks for the public renderer to splice in. normalizeBlock rebuilds
  // each block from a fixed allow-list and would otherwise silently drop it, so
  // any incidental re-normalization (e.g. getRootChildren) would strip the
  // resolved content and the symbol would fall back to its placeholder.
  if (Array.isArray(block.__symbolChildren)) {
    normalized.__symbolChildren = block.__symbolChildren;
  }

  return normalized;
}

// Resolve geometry/visibility for a block at a given breakpoint by
// cascading mobile -> tablet -> desktop. Returns { x, y, w, h, hidden }.
//
// If the block is marked `fullWidth`, x is pinned to 0 and w is forced to
// the breakpoint's canvas width (overriding any stored bp values). The
// stored bp.x / bp.w values are preserved on the block — turning the
// toggle off restores manual sizing on top of whatever is currently
// stored (or the inspector can snapshot the rendered geometry first).
export function resolveBlockAtBreakpoint(block, breakpoint, options) {
  const d = block.bp?.desktop || {};
  const t = block.bp?.tablet || {};
  const m = block.bp?.mobile || {};
  const base = { x: 40, y: 40, w: 200, h: 120, hidden: false, ...d };
  let geom;
  if (breakpoint === 'desktop') {
    geom = base;
  } else if (breakpoint === 'tablet') {
    geom = { ...base, ...stripUndefined(t) };
  } else {
    geom = { ...base, ...stripUndefined(t), ...stripUndefined(m) };
  }
  if (blockIsFullWidthLike(block)) {
    const cw = options && Number.isFinite(options.canvasWidth)
      ? options.canvasWidth
      : (BREAKPOINT_WIDTHS[breakpoint] || BREAKPOINT_WIDTHS.desktop);
    return { ...geom, x: 0, w: cw };
  }
  return geom;
}

// Task #2451 / #2460: display-only clamp for tablet/mobile rendering.
// Desktop-authored geometry cascades down when a block has no explicit
// tablet/mobile frame, so a 1200px-wide block would spill past the 375px
// stage edge. Constrain the RENDERED geometry so x + w never exceeds the
// stage width: clamp the width, and pull x back inside the stage if x alone
// is past the edge. This never touches stored geometry — it is a no-op on
// desktop and on frames that already fit. Shared by the editor stage
// (CanvasStage), the published-page stylesheet (buildCanvasCss) and the
// forced-breakpoint preview (CanvasPageRenderer) so the three surfaces
// can't drift.
export function clampGeomToStage(geom, breakpoint, canvasWidth) {
  if (breakpoint === 'desktop') return geom;
  if (!geom || geom.hidden) return geom;
  if (!Number.isFinite(canvasWidth) || canvasWidth <= 0) return geom;
  const x = Number.isFinite(geom.x) ? geom.x : 0;
  const w = Number.isFinite(geom.w) ? geom.w : 0;
  if (x + w <= canvasWidth) return geom;
  let nx = x;
  if (nx >= canvasWidth) nx = Math.max(0, canvasWidth - Math.min(w, canvasWidth));
  const nw = Math.max(1, Math.min(w, canvasWidth - Math.max(0, nx)));
  return { ...geom, x: nx, w: nw };
}

// Task #970: per-device raw-px values (font size, line spacing, icon size,
// button size sub-fields). Stored either as a scalar number (no responsive
// override — byte-identical to pre-#970 blocks) or as a partial object
// `{ desktop?, tablet?, mobile? }`. At read time we cascade
// mobile -> tablet -> desktop so tablet/mobile inherit when blank, matching
// the Position panel's resolution pattern. Non-finite/empty inputs return
// undefined so callers can fall back to their pre-existing defaults.
export function resolveResponsiveValue(value, breakpoint) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const d = Number.isFinite(value.desktop) ? value.desktop : undefined;
  const t = Number.isFinite(value.tablet) ? value.tablet : undefined;
  const m = Number.isFinite(value.mobile) ? value.mobile : undefined;
  if (breakpoint === 'mobile') return m ?? t ?? d;
  if (breakpoint === 'tablet') return t ?? d;
  return d;
}

// True when the given responsive value has at least one finite numeric
// entry at ANY breakpoint (scalar number, or object with desktop/tablet/
// mobile keys). Public renderers use this to decide whether to switch a
// block onto the inline / CSS-var styled path even when the current
// resolved value happens to be undefined (e.g. only a mobile override
// is set, but we're rendering at desktop). Blocks where this returns
// false stay byte-identical to today.
export function hasAnyResponsiveValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return ['desktop', 'tablet', 'mobile'].some((k) => Number.isFinite(value[k]));
}

// True when the given responsive value has its own entry for `breakpoint`.
// Scalar values count as a desktop entry; object values check for a finite
// numeric value at that key. Anything else returns false.
export function hasResponsiveOverride(value, breakpoint) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return breakpoint === 'desktop' && Number.isFinite(value);
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return Number.isFinite(value[breakpoint]);
}

// Write `next` (a finite number or null/undefined to clear) at `breakpoint`
// onto a responsive value, returning the normalised next value. The result
// is either a scalar number (only the desktop slot is set) or a partial
// object — and `undefined` when no slot is set. This preserves byte-identity
// for blocks that never use tablet/mobile overrides.
export function writeResponsiveValue(current, breakpoint, next) {
  let obj;
  if (typeof current === 'number' && Number.isFinite(current)) {
    obj = { desktop: current };
  } else if (current && typeof current === 'object' && !Array.isArray(current)) {
    obj = {};
    for (const k of ['desktop', 'tablet', 'mobile']) {
      if (Number.isFinite(current[k])) obj[k] = current[k];
    }
  } else {
    obj = {};
  }
  const finite = Number.isFinite(next);
  if (!finite) {
    delete obj[breakpoint];
  } else {
    obj[breakpoint] = next;
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) return undefined;
  if (keys.length === 1 && keys[0] === 'desktop') return obj.desktop;
  return obj;
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
// Task #1425: layer groups
//
// Groups are a flat registry on `root.groups` keyed by id. A block belongs
// to a group via its `groupId`. There is no nesting (v1). Helpers always
// round-trip through normalizeCanvasDesign so the returned document has a
// consistent groups registry (dangling refs cleared, empty groups pruned).
// ---------------------------------------------------------------------------

export function getGroups(design) {
  return normalizeCanvasDesign(design).root.groups;
}

export function setGroups(design, groups) {
  const d = normalizeCanvasDesign(design);
  return {
    ...d,
    root: { ...d.root, groups: Array.isArray(groups) ? groups : [] },
  };
}

// ---------------------------------------------------------------------------
// Task #1665 / #1667: editor-only ruler guides
//
// `root.guides` is `{ vertical: Guide[], horizontal: Guide[] }` where each
// Guide is `{ pos, locked }` in stage coordinates. Helpers round-trip through
// normalizeCanvasDesign so the stored arrays are always cleaned (finite pos
// >= 0, de-duplicated by pos, sorted ascending). The public renderer never
// reads these, so they cannot leak into a live page.
// ---------------------------------------------------------------------------

export function getCanvasGuides(design) {
  return normalizeCanvasDesign(design).root.guides;
}

export function setCanvasGuides(design, guides) {
  const d = normalizeCanvasDesign(design);
  return {
    ...d,
    root: { ...d.root, guides: normalizeGuides(guides) },
  };
}

// Plain `{ vertical: number[], horizontal: number[] }` of guide positions,
// for snap targets in the stage which don't care about lock state.
export function getCanvasGuidePositions(design) {
  const g = getCanvasGuides(design);
  return {
    vertical: g.vertical.map((x) => x.pos),
    horizontal: g.horizontal.map((x) => x.pos),
  };
}

// All member blocks of `groupId`, in document (z-order) order.
export function getGroupMembers(children, groupId) {
  if (!groupId || !Array.isArray(children)) return [];
  return children.filter((b) => b && b.groupId === groupId);
}

// Create a new group from `memberIds`. Members that already belonged to
// other groups are moved into the new group; any group left empty as a
// result is pruned by normalization. Returns { design, groupId } or null
// when fewer than two valid members are supplied.
export function createGroup(design, memberIds, name) {
  const d = normalizeCanvasDesign(design);
  const children = d.root.sections[0]?.children || [];
  const valid = (Array.isArray(memberIds) ? memberIds : []).filter((id) =>
    children.some((b) => b.id === id));
  const uniqueValid = Array.from(new Set(valid));
  if (uniqueValid.length < 2) return null;

  const groupId = generateId('group');
  const groupName = name && String(name).trim()
    ? String(name).trim()
    : `Group ${d.root.groups.length + 1}`;
  const idSet = new Set(uniqueValid);
  const nextChildren = children.map((b) =>
    idSet.has(b.id) ? { ...b, groupId } : b);
  const nextGroups = [...d.root.groups, { id: groupId, name: groupName, collapsed: false }];
  const next = {
    ...d,
    root: {
      ...d.root,
      groups: nextGroups,
      sections: [{ ...d.root.sections[0], children: nextChildren }],
    },
  };
  // Normalize to prune any group that just lost its last member.
  return { design: normalizeCanvasDesign(next), groupId };
}

// Disband a group: clear `groupId` on its members and drop the registry
// entry. No-op (returns a normalized copy) when the group does not exist.
export function ungroup(design, groupId) {
  const d = normalizeCanvasDesign(design);
  if (!groupId) return d;
  const children = d.root.sections[0]?.children || [];
  const nextChildren = children.map((b) =>
    b.groupId === groupId ? { ...b, groupId: null } : b);
  const nextGroups = d.root.groups.filter((g) => g.id !== groupId);
  return normalizeCanvasDesign({
    ...d,
    root: {
      ...d.root,
      groups: nextGroups,
      sections: [{ ...d.root.sections[0], children: nextChildren }],
    },
  });
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
    case BLOCK_TYPES.VERTICAL_DIVIDER:
      // Vertical dividers are purely decorative; no required content. The
      // explicit case registers the block type in the validator (matching the
      // horizontal divider, which likewise carries no validation errors).
      break;
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
    case BLOCK_TYPES.IMAGE: {
      const hasIcon = c.iconClass && String(c.iconClass).trim();
      if (!c.src && !hasIcon) errors.push('Image source or icon is required.');
      if (c.src && (!c.alt || !String(c.alt).trim())) {
        errors.push('Image requires alt text for accessibility.');
      }
      break;
    }
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
    case BLOCK_TYPES.EVENT_SESSIONS:
      if (!c.eventId) errors.push('Event sessions block requires a multi-session event.');
      break;
    case BLOCK_TYPES.SPEAKER_CAROUSEL:
      if (!c.eventId) errors.push('Speaker carousel requires an event.');
      break;
    case BLOCK_TYPES.SPEAKER_GRID:
      if (!c.eventId) errors.push('Speaker grid requires an event.');
      break;
    case BLOCK_TYPES.SPONSOR_GRID:
      if (!c.eventId) errors.push('Sponsor grid requires an event.');
      break;
    case BLOCK_TYPES.SPONSOR_CAROUSEL:
      if (!c.eventId) errors.push('Sponsor carousel requires an event.');
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
    case BLOCK_TYPES.CARD_DECK:
      if (!Array.isArray(c.cardIds) || c.cardIds.filter(Boolean).length === 0) {
        errors.push('Card deck has no cards selected.');
      }
      break;
    case BLOCK_TYPES.WALL_OF_FAME:
      if (!c.sectionId) {
        errors.push('Wall of Fame has no section selected.');
      }
      break;
    case BLOCK_TYPES.GALLERY:
      if (!c.gallerySlug) {
        errors.push('Photo Gallery has no gallery selected.');
      }
      break;
    case BLOCK_TYPES.CARD_FLIP_GRID: {
      const cards = Array.isArray(c.cards) ? c.cards : [];
      if (cards.length === 0) {
        errors.push('Card Flip Grid has no cards.');
      }
      cards.forEach((card, i) => {
        if (!card?.title || !String(card.title).trim()) {
          errors.push(`Card #${i + 1} requires a title.`);
        }
        if (card?.image && (!card.imageAlt || !String(card.imageAlt).trim())) {
          errors.push(`Card #${i + 1} image requires alt text.`);
        }
      });
      // `columns` is either a legacy single number or a per-breakpoint
      // object { desktop, tablet, mobile }. Accept either, requiring at
      // least one valid (>=1) column value.
      const colVals = (c.columns && typeof c.columns === 'object')
        ? ['desktop', 'tablet', 'mobile'].map((bp) => Number(c.columns[bp]))
        : [Number(c.columns)];
      if (!colVals.some((n) => Number.isFinite(n) && n >= 1)) {
        errors.push('Card Flip Grid needs at least 1 column.');
      }
      if (!(Number(c.rowsPerPage) >= 1)) errors.push('Card Flip Grid needs at least 1 row per page.');
      if (c.titleAlignment != null && !['left', 'center', 'right'].includes(c.titleAlignment)) {
        errors.push('Card Flip Grid title alignment must be left, center, or right.');
      }
      break;
    }
    case BLOCK_TYPES.PRICING_TABLE: {
      const tiers = Array.isArray(c.tiers) ? c.tiers : [];
      if (tiers.length < 2) errors.push('Pricing table needs at least 2 tiers.');
      if (tiers.length > 6) errors.push('Pricing table supports a maximum of 6 tiers.');
      tiers.forEach((t, i) => {
        if (!t?.name || !String(t.name).trim()) errors.push(`Pricing tier #${i + 1} requires a name.`);
        if (t?.ctaLabel && !t?.ctaHref) errors.push(`Pricing tier #${i + 1} CTA needs a link.`);
      });
      if (tiers.filter((t) => t?.recommended).length > 1) {
        errors.push('Only one pricing tier can be marked recommended.');
      }
      break;
    }
    case BLOCK_TYPES.TESTIMONIAL_GRID: {
      const items = Array.isArray(c.items) ? c.items : [];
      items.forEach((t, i) => {
        if (!t?.quote || !String(t.quote).trim()) errors.push(`Testimonial #${i + 1} requires a quote.`);
        if (!t?.author || !String(t.author).trim()) errors.push(`Testimonial #${i + 1} requires an author name.`);
        if (t?.avatarUrl && !String(t.avatarAlt || '').trim()) {
          errors.push(`Testimonial #${i + 1} avatar requires alt text.`);
        }
        if (t?.companyLogoUrl && !String(t.companyLogoAlt || '').trim()) {
          errors.push(`Testimonial #${i + 1} company logo requires alt text.`);
        }
      });
      break;
    }
    case BLOCK_TYPES.MEGA_MENU: {
      const items = Array.isArray(c.items) ? c.items : [];
      items.forEach((it, i) => {
        if (!it?.label || !String(it.label).trim()) {
          errors.push(`Menu item #${i + 1} requires a label.`);
        }
        const cols = Array.isArray(it?.columns) ? it.columns : [];
        // An explicit per-item toggle wins; otherwise infer a panel from
        // populated dropdown/featured content (keep in sync with
        // megaItemHasPanel in registry.jsx).
        const hasPanel = typeof it?.hasPanel === 'boolean'
          ? it.hasPanel
          : (cols.length > 0
            || !!it?.featuredImage
            || !!(it?.featuredTitle && String(it.featuredTitle).trim())
            || !!(it?.featuredText && String(it.featuredText).trim()));
        if (!hasPanel && !it?.href) {
          errors.push(`Menu item #${i + 1} needs a link or a dropdown.`);
        }
        cols.forEach((col, ci) => {
          (Array.isArray(col?.links) ? col.links : []).forEach((ln, li) => {
            if (!ln?.label || !String(ln.label).trim()) {
              errors.push(`Menu item #${i + 1} column #${ci + 1} link #${li + 1} requires a label.`);
            }
            if (!ln?.href) {
              errors.push(`Menu item #${i + 1} column #${ci + 1} link #${li + 1} requires a URL.`);
            }
          });
        });
        if (it?.featuredImage && !String(it?.featuredAlt || '').trim()) {
          errors.push(`Menu item #${i + 1} featured image requires alt text.`);
        }
      });
      break;
    }
    case BLOCK_TYPES.COUNTDOWN: {
      const linkedToEvent = !!(c.eventSlug || c.eventId);
      if (!linkedToEvent && (!c.targetDate || Number.isNaN(new Date(c.targetDate).getTime()))) {
        errors.push('Countdown requires a valid target date and time.');
      }
      if (!c.showDays && !c.showHours && !c.showMinutes && !c.showSeconds) {
        errors.push('Countdown must show at least one unit.');
      }
      break;
    }
    case BLOCK_TYPES.ACCORDION: {
      const items = Array.isArray(c.items) ? c.items : [];
      items.forEach((it, i) => {
        const links = Array.isArray(it?.links) ? it.links : [];
        links.forEach((l, j) => {
          const hasLabel = !!(l?.label && String(l.label).trim());
          const hasUrl = !!(l?.url && String(l.url).trim());
          if (hasLabel && !hasUrl) {
            errors.push(`Accordion item #${i + 1} link #${j + 1} needs a URL.`);
          }
          if (hasUrl && !hasLabel) {
            errors.push(`Accordion item #${i + 1} link #${j + 1} needs a label.`);
          }
        });
      });
      break;
    }
    case BLOCK_TYPES.HERO_CAROUSEL: {
      const carouselSlides = Array.isArray(c.slides) ? c.slides : [];
      if (carouselSlides.length === 0) {
        errors.push('Hero Carousel has no slides.');
      }
      break;
    }
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

// Resolve an explicit CSS height override for a block, or null to fall back to
// the geometry height. Currently only the Image block supports this, and only
// when full-bleed is on (see the Image block defaults). Returns a CSS length
// string (e.g. '40vh', '300px') or null for the default 'auto' behaviour.
export function resolveBlockHeightCss(block) {
  const c = block && block.content;
  if (!c) return null;
  if (block.type !== BLOCK_TYPES.IMAGE || !c.fullBleed) return null;
  const v = Number(c.heightValue);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (c.heightMode === 'px') return fmtPx(v);
  if (c.heightMode === 'vh') return `${v}vh`;
  return null;
}

function geomRule(geom, { fullBleed, fullWidth, heightCss } = {}) {
  if (geom.hidden) return 'display:none;';
  const h = heightCss || fmtPx(geom.h);
  if (fullBleed) {
    return [
      'display:block;',
      'position:absolute;',
      'left:50%;',
      'transform:translateX(-50%);',
      'width:100vw;',
      `top:${fmtPx(geom.y)};`,
      `height:${h};`,
    ].join('');
  }
  if (fullWidth) {
    return [
      'display:block;',
      'position:absolute;',
      'left:0;',
      'width:100%;',
      `top:${fmtPx(geom.y)};`,
      `height:${h};`,
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

// Task #972: per-block CSS variable definitions for per-device text /
// icon sizes added in task #970. The renderers (EventCarouselRender,
// ButtonRender, IconRender) read these via `var(--name, fallback)` so
// the per-page stylesheet drives layout on real public pages — no JS
// needed for breakpoint resolution. The fallback in the renderer kicks
// in whenever a block has no override at any breakpoint (the var is
// simply never declared), keeping pre-#970 byte-identity intact.
const RESPONSIVE_VAR_FIELDS = {
  [BLOCK_TYPES.EVENT_CAROUSEL]: [
    { contentKey: 'dateFontSize',        varName: '--cb-ev-date-fs',    unit: 'px' },
    { contentKey: 'titleFontSize',       varName: '--cb-ev-title-fs',   unit: 'px' },
    { contentKey: 'summaryFontSize',     varName: '--cb-ev-summary-fs', unit: 'px' },
    { contentKey: 'titleLineHeight',     varName: '--cb-ev-title-lh',   unit: '' },
    { contentKey: 'summaryLineHeight',   varName: '--cb-ev-summary-lh', unit: '' },
    { contentKey: 'dateIconSize',        varName: '--cb-ev-date-icon',  unit: 'px' },
    { contentKey: 'placeholderIconSize', varName: '--cb-ev-ph-icon',    unit: 'px' },
  ],
  [BLOCK_TYPES.SPEAKER_CAROUSEL]: [
    { contentKey: 'nameFontSize',  varName: '--cb-sp-name-fs',  unit: 'px' },
    { contentKey: 'titleFontSize', varName: '--cb-sp-title-fs', unit: 'px' },
    { contentKey: 'orgFontSize',   varName: '--cb-sp-org-fs',   unit: 'px' },
  ],
  [BLOCK_TYPES.SPEAKER_GRID]: [
    { contentKey: 'nameFontSize',  varName: '--cb-spgr-name-fs',  unit: 'px' },
    { contentKey: 'titleFontSize', varName: '--cb-spgr-title-fs', unit: 'px' },
    { contentKey: 'orgFontSize',   varName: '--cb-spgr-org-fs',   unit: 'px' },
  ],
  [BLOCK_TYPES.SPONSOR_GRID]: [
    { contentKey: 'nameFontSize', varName: '--cb-spg-name-fs', unit: 'px' },
    { contentKey: 'descFontSize', varName: '--cb-spg-desc-fs', unit: 'px' },
  ],
  [BLOCK_TYPES.SPONSOR_CAROUSEL]: [
    { contentKey: 'nameFontSize', varName: '--cb-spc-name-fs', unit: 'px' },
    { contentKey: 'descFontSize', varName: '--cb-spc-desc-fs', unit: 'px' },
  ],
  [BLOCK_TYPES.ICON]: [
    { contentKey: 'size', varName: '--cb-icon-size', unit: 'px' },
  ],
};

// Button is a special case: the four per-device sub-fields live inside
// `content.size` (object), not as top-level content keys.
const BUTTON_RESPONSIVE_SIZE_FIELDS = [
  { sizeKey: 'paddingX', varName: '--cb-btn-px',   unit: 'px' },
  { sizeKey: 'paddingY', varName: '--cb-btn-py',   unit: 'px' },
  { sizeKey: 'fontSize', varName: '--cb-btn-fs',   unit: 'px' },
  { sizeKey: 'iconSize', varName: '--cb-btn-icon', unit: 'px' },
];

function collectBlockResponsiveVars(block, breakpoint) {
  const out = {};
  const c = block.content || {};
  const fields = RESPONSIVE_VAR_FIELDS[block.type];
  if (fields) {
    for (const { contentKey, varName, unit } of fields) {
      const v = resolveResponsiveValue(c[contentKey], breakpoint);
      if (Number.isFinite(v)) out[varName] = unit ? `${v}${unit}` : String(v);
    }
  }
  if (block.type === BLOCK_TYPES.BUTTON) {
    const sz = c.size;
    if (sz && typeof sz === 'object' && !Array.isArray(sz)) {
      for (const { sizeKey, varName, unit } of BUTTON_RESPONSIVE_SIZE_FIELDS) {
        const v = resolveResponsiveValue(sz[sizeKey], breakpoint);
        if (Number.isFinite(v)) out[varName] = unit ? `${v}${unit}` : String(v);
      }
    }
  }
  return out;
}

function varsRuleBody(vars) {
  const entries = Object.entries(vars);
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}:${v};`).join('');
}

export function stageHeightForBreakpoint(blocks, breakpoint, options) {
  // `buffer` is empty space added below the lowest block. The editor keeps a
  // default buffer so there is room to drag/drop new blocks below existing
  // content, but the published render passes buffer:0 so the last element sits
  // tight against the footer (no spurious gap).
  const buffer = options && Number.isFinite(options.buffer) ? options.buffer : 80;
  const minHeight = options && Number.isFinite(options.minHeight) ? options.minHeight : 240;
  let h = minHeight;
  for (const b of blocks) {
    const g = resolveBlockAtBreakpoint(b, breakpoint);
    if (g.hidden) continue;
    h = Math.max(h, (g.y || 0) + (g.h || 0) + buffer);
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

  // Stage heights per breakpoint. The published render uses buffer:0 so the
  // last element sits tight to whatever follows (e.g. the footer); the editor
  // computes its own stage height separately with the default buffer.
  const hD = stageHeightForBreakpoint(blocks, 'desktop', { buffer: 0 });
  const hT = stageHeightForBreakpoint(blocks, 'tablet', { buffer: 0 });
  const hM = stageHeightForBreakpoint(blocks, 'mobile', { buffer: 0 });
  const stageSel = `${sc} .canvas-stage`;
  lines.push(`${stageSel}{position:relative;width:100%;max-width:${BREAKPOINT_WIDTHS.desktop}px;margin:0 auto;height:${fmtPx(hD)};--cb-content-width:${BREAKPOINT_WIDTHS.desktop}px;}`);

  for (const b of blocks) {
    const id = escapeCssIdent(b.id);
    const sel = `${sc} [data-cb="${id}"]`;
    const fullBleed = blockSupportsFullBleed(b.type) && !!(b.content && b.content.fullBleed);
    const fullWidth = !!b.fullWidth;
    const heightCss = resolveBlockHeightCss(b);
    const dG = resolveBlockAtBreakpoint(b, 'desktop');
    lines.push(`${sel}{${geomRule(dG, { fullBleed, fullWidth, heightCss })}}`);
  }

  // Task #972: per-block CSS variables for per-device text/icon sizes
  // (Event Carousel, Button, Icon — see RESPONSIVE_VAR_FIELDS above).
  // Desktop values are emitted unconditionally so the var resolves on
  // wide viewports; tablet/mobile diffs are added to the @media blocks
  // below. Blocks with no per-device overrides at any breakpoint emit
  // nothing here, keeping their stylesheet output byte-identical to
  // pre-#972.
  for (const b of blocks) {
    const dv = collectBlockResponsiveVars(b, 'desktop');
    if (Object.keys(dv).length === 0) continue;
    const id = escapeCssIdent(b.id);
    lines.push(`${sc} [data-cb="${id}"]{${varsRuleBody(dv)}}`);
  }

  // Tablet overrides.
  const tabletRules = [];
  for (const b of blocks) {
    const id = escapeCssIdent(b.id);
    const sel = `${sc} [data-cb="${id}"]`;
    const fullBleed = blockSupportsFullBleed(b.type) && !!(b.content && b.content.fullBleed);
    const fullWidth = !!b.fullWidth;
    const heightCss = resolveBlockHeightCss(b);
    const dG = resolveBlockAtBreakpoint(b, 'desktop');
    // Task #2460: clamp the rendered tablet geometry to the tablet stage
    // width BEFORE comparing to desktop, so a desktop-cascaded over-wide
    // block (identical stored frames) still emits a clamped override rule
    // instead of letting the desktop width spill past the stage edge.
    // Full-width/full-bleed blocks are skipped (x/w forced by geomRule).
    const tG = clampGeomToStage(
      resolveBlockAtBreakpoint(b, 'tablet'),
      'tablet',
      BREAKPOINT_WIDTHS.tablet,
    );
    // Full-width / full-bleed blocks have their x/w forced by geomRule
    // (100% or 100vw), so per-breakpoint x/w differences (which only come
    // from the breakpoint stage width) must not trigger a redundant
    // override — compare y/h/hidden only for those.
    const fwLike = fullWidth || fullBleed;
    const geomDiffers = fwLike
      ? (tG.y !== dG.y || tG.h !== dG.h || !!tG.hidden !== !!dG.hidden)
      : (tG.x !== dG.x || tG.y !== dG.y || tG.w !== dG.w || tG.h !== dG.h || !!tG.hidden !== !!dG.hidden);
    if (geomDiffers) {
      tabletRules.push(`${sel}{${geomRule(tG, { fullBleed, fullWidth, heightCss })}}`);
    }
  }
  // Task #972: tablet var diffs — only emit keys that differ from the
  // unconditional desktop rule so identical values don't double up.
  for (const b of blocks) {
    const dv = collectBlockResponsiveVars(b, 'desktop');
    const tv = collectBlockResponsiveVars(b, 'tablet');
    const diff = {};
    for (const k of new Set([...Object.keys(dv), ...Object.keys(tv)])) {
      if (tv[k] !== undefined && tv[k] !== dv[k]) diff[k] = tv[k];
    }
    if (Object.keys(diff).length) {
      const id = escapeCssIdent(b.id);
      tabletRules.push(`${sc} [data-cb="${id}"]{${varsRuleBody(diff)}}`);
    }
  }
  if (tabletRules.length) {
    lines.push(`@media (max-width: ${BREAKPOINT_MAX_PX.tablet}px){`);
    lines.push(`${stageSel}{max-width:${BREAKPOINT_WIDTHS.tablet}px;height:${fmtPx(hT)};--cb-content-width:${BREAKPOINT_WIDTHS.tablet}px;}`);
    lines.push(tabletRules.join(''));
    lines.push('}');
  } else {
    lines.push(`@media (max-width: ${BREAKPOINT_MAX_PX.tablet}px){${stageSel}{max-width:${BREAKPOINT_WIDTHS.tablet}px;height:${fmtPx(hT)};--cb-content-width:${BREAKPOINT_WIDTHS.tablet}px;}}`);
  }

  // Mobile overrides.
  const mobileRules = [];
  for (const b of blocks) {
    const id = escapeCssIdent(b.id);
    const sel = `${sc} [data-cb="${id}"]`;
    const fullBleed = blockSupportsFullBleed(b.type) && !!(b.content && b.content.fullBleed);
    const fullWidth = !!b.fullWidth;
    const heightCss = resolveBlockHeightCss(b);
    // Task #2460: compare the clamped mobile geometry against the clamped
    // tablet geometry — the tablet @media rule (which also matches at
    // mobile widths) already renders the clamped tablet frame, so the
    // mobile override only needs emitting when the clamped results differ.
    const tG = clampGeomToStage(
      resolveBlockAtBreakpoint(b, 'tablet'),
      'tablet',
      BREAKPOINT_WIDTHS.tablet,
    );
    const mG = clampGeomToStage(
      resolveBlockAtBreakpoint(b, 'mobile'),
      'mobile',
      BREAKPOINT_WIDTHS.mobile,
    );
    const fwLike = fullWidth || fullBleed;
    const geomDiffers = fwLike
      ? (mG.y !== tG.y || mG.h !== tG.h || !!mG.hidden !== !!tG.hidden)
      : (mG.x !== tG.x || mG.y !== tG.y || mG.w !== tG.w || mG.h !== tG.h || !!mG.hidden !== !!tG.hidden);
    if (geomDiffers) {
      mobileRules.push(`${sel}{${geomRule(mG, { fullBleed, fullWidth, heightCss })}}`);
    }
  }
  // Task #972: mobile var diffs — compare against tablet (which already
  // cascades from desktop), so the mobile @media block only re-declares
  // vars that change between tablet and mobile.
  for (const b of blocks) {
    const tv = collectBlockResponsiveVars(b, 'tablet');
    const mv = collectBlockResponsiveVars(b, 'mobile');
    const diff = {};
    for (const k of new Set([...Object.keys(tv), ...Object.keys(mv)])) {
      if (mv[k] !== undefined && mv[k] !== tv[k]) diff[k] = mv[k];
    }
    if (Object.keys(diff).length) {
      const id = escapeCssIdent(b.id);
      mobileRules.push(`${sc} [data-cb="${id}"]{${varsRuleBody(diff)}}`);
    }
  }
  if (mobileRules.length) {
    lines.push(`@media (max-width: ${BREAKPOINT_MAX_PX.mobile}px){`);
    lines.push(`${stageSel}{max-width:${BREAKPOINT_WIDTHS.mobile}px;height:${fmtPx(hM)};--cb-content-width:${BREAKPOINT_WIDTHS.mobile}px;}`);
    lines.push(mobileRules.join(''));
    lines.push('}');
  } else {
    lines.push(`@media (max-width: ${BREAKPOINT_MAX_PX.mobile}px){${stageSel}{max-width:${BREAKPOINT_WIDTHS.mobile}px;height:${fmtPx(hM)};--cb-content-width:${BREAKPOINT_WIDTHS.mobile}px;}}`);
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
      if (b.type === BLOCK_TYPES.HERO_CAROUSEL && (c.slides || []).some((s) => s.backgroundImage)) return true;
      return false;
    })
    .sort((a, b) => (a.g.y || 0) - (b.g.y || 0));
  return candidates.length ? candidates[0].b.id : null;
}

// ---------------------------------------------------------------------------
// Task #1446: in-page anchor links ("jump links")
//
// Any block may carry an `anchorId` — a URL-safe slug rendered as a real
// HTML `id` on the public block wrapper so links like `#contact` scroll to
// it. These helpers centralise sanitization, the page-wide anchor list (used
// by the link-field anchor pickers) and duplicate detection.
// ---------------------------------------------------------------------------

// Convert free text into a safe in-page anchor slug. Lowercased, spaces and
// underscores collapse to hyphens, anything outside [a-z0-9-] is dropped,
// leading/trailing hyphens trimmed, capped at 64 chars. Returns '' for empty
// or fully-invalid input.
export function sanitizeAnchorId(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// Flat list of every block that has an anchor id, in document order.
// Each entry: { blockId, anchorId, blockName, blockType, duplicate }.
// `duplicate` is true for the 2nd+ occurrence of a repeated anchor id.
export function getPageAnchors(design) {
  if (!design || typeof design !== 'object') return [];
  const sections = Array.isArray(design?.root?.sections) ? design.root.sections : [];
  const out = [];
  const seen = new Set();
  for (const section of sections) {
    for (const block of (section?.children || [])) {
      const anchorId = sanitizeAnchorId(block?.anchorId || '');
      if (!anchorId) continue;
      out.push({
        blockId: block.id,
        anchorId,
        blockName: block.name || block.type || 'Block',
        blockType: block.type,
        duplicate: seen.has(anchorId),
      });
      seen.add(anchorId);
    }
  }
  return out;
}

// Set of anchor ids that appear on more than one block in the page.
export function findDuplicateAnchorIds(design) {
  const counts = {};
  for (const a of getPageAnchors(design)) {
    counts[a.anchorId] = (counts[a.anchorId] || 0) + 1;
  }
  return new Set(Object.keys(counts).filter((k) => counts[k] > 1));
}

export function validateCanvasDesign(design) {
  const d = normalizeCanvasDesign(design);
  const issues = [];
  const duplicateAnchors = findDuplicateAnchorIds(d);
  for (const section of d.root.sections) {
    for (const block of section.children || []) {
      const errs = validateBlock(block);
      const anchorId = sanitizeAnchorId(block.anchorId || '');
      if (anchorId && duplicateAnchors.has(anchorId)) {
        errs.push(`Anchor ID "#${anchorId}" is used by more than one block — make it unique so jump links stay unambiguous.`);
      }
      if (errs.length > 0) {
        issues.push({ blockId: block.id, blockName: block.name, blockType: block.type, errors: errs });
      }
    }
  }
  return issues;
}

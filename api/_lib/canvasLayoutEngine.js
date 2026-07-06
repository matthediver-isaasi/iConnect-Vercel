// Shared Canvas Builder layout engine.
//
// Extracted verbatim from scripts/provision-canvas-page-from-doc.mjs so both the
// one-off provisioning script AND the in-app "Create page from document" feature
// build canvas_design documents through a SINGLE source of truth. The geometry,
// block factories and rhythm here are the canonical target that
// scripts/lib/canvasSpacing.mjs mirrors for its normalizer.
//
// buildDesign(spec) is parameterized on two optional inputs so it works for ANY
// tenant, not just BNMS:
//   - spec.theme : a THEMES key string (bnms/ukrg/mrt) OR a theme object. When
//                  omitted, defaults to the BNMS theme (script behaviour).
//   - spec.typo  : an object of typography-style UUIDs. When omitted, defaults
//                  to the BNMS TYPO ids (script behaviour). Pass EMPTY_TYPO for
//                  non-BNMS tenants — the Canvas renderer degrades gracefully
//                  when typographyStyleId is empty/foreign (falls back to
//                  headingAs / headingLevel), so pages render correctly with the
//                  tenant's own default fonts.
//
// buildNeutralDesign(spec) is the convenience the in-app feature uses: it forces
// EMPTY_TYPO + a NEUTRAL_THEME whose colours are tenant CSS variables, so the
// generated page adopts the current tenant's branding.

// ---------------------------------------------------------------------------
// Typography style ids from the BNMS award/application pages (verified as
// tenant-owned). Only meaningful for the BNMS tenant; other tenants pass
// EMPTY_TYPO.
// ---------------------------------------------------------------------------
export const TYPO = {
  heroHeadline: '7c9e9a3f-4c60-4ee9-a8ec-4bd83325f7e5',
  heroSub: '8e020a66-1192-4266-a566-6d02f6d78a37',
  h2: '5758a939-15f7-471e-9473-f702e791ee40',
  h3: '5adf6d13-1d12-4613-ac55-b4bb1345c168',
  body: 'c6f2ef1a-0e3e-4823-9ccb-290876da2f98',
  cardHeading: 'd16866a7-5cab-4854-8576-cb3d92081bc8',
};

// Empty typography set for non-BNMS tenants — the renderer falls back to
// headingAs / headingLevel and the tenant's default fonts.
export const EMPTY_TYPO = {
  heroHeadline: '',
  heroSub: '',
  h2: '',
  h3: '',
  body: '',
  cardHeading: '',
};

// Visual themes. The default BNMS theme uses the orange accent + light-blue
// colour band of the existing award/application pages. UKRG / MRT mirror their
// respective hand-built pages. Selected per-page via spec.theme.
export const THEMES = {
  bnms: {
    accent: '#fa8300',
    bandBg: '#F4F7FF',
    dividerColor: '#fa8300',
    cardHighlight: '#F4F7FF',
    buttonVariant: 'tenant:primary-no-icon',
    heroOverlay: {
      direction: 'to-right',
      fromColor: '#0055ff',
      stops: [
        { color: '#4169e1', opacity: 1, position: 19 },
        { color: '#000000', opacity: 0, position: 98 },
      ],
    },
  },
  ukrg: {
    accent: '#ff4242',
    bandBg: '#fff5f5',
    dividerColor: '#00aaff',
    cardHighlight: '#fff5f5',
    buttonVariant: 'tenant:ukrg',
    heroOverlay: {
      direction: 'to-left',
      fromColor: '#0055ff',
      stops: [
        { color: '#ff4242', opacity: 1, position: 21 },
        { color: '#000000', opacity: 0, position: 98 },
      ],
    },
  },
  mrt: {
    accent: '#940c1f',
    bandBg: '#fffbf5',
    dividerColor: '#940c1f',
    cardHighlight: '#fffbf5',
    buttonVariant: 'tenant:mrt',
    heroOverlay: {
      direction: 'to-left',
      fromColor: '#0055ff',
      stops: [
        { color: '#ff8442', opacity: 1, position: 21 },
        { color: '#000000', opacity: 0, position: 98 },
      ],
    },
    logoUrl:
      'https://vault.iconn.app/storage/v1/object/public/public-assets/ff2df806-b321-4254-b651-3af11fccf1db/uploads/1782140538344-b5ytp8f-bnmsmrt_consortium_logo.jpg',
  },
};

// Tenant-neutral theme: colours are Canvas CSS variables so the generated page
// adopts the current tenant's branding at render time. Falls back to sensible
// slate/blue defaults if a tenant has not set a variable.
export const NEUTRAL_THEME = {
  accent: 'var(--cb-color-primary, #2563eb)',
  bandBg: 'var(--cb-color-muted, #f1f5f9)',
  dividerColor: 'var(--cb-color-primary, #2563eb)',
  cardHighlight: 'var(--cb-color-muted, #f1f5f9)',
  buttonVariant: 'tenant:primary',
  heroOverlay: {
    direction: 'to-right',
    fromColor: '#0f172a',
    stops: [
      { color: '#0f172a', opacity: 0.7, position: 0 },
      { color: '#000000', opacity: 0, position: 98 },
    ],
  },
};

// Mutable active theme / typography — set at the top of buildDesign() from spec.
// The block factories read these at call time (buildDesign runs synchronously
// start to finish per page, so there is no cross-page bleed).
let THEME = THEMES.bnms;
let TYPO_ACTIVE = TYPO;

// ---------------------------------------------------------------------------
// Block factories — each returns a block whose style / typography / content
// shape is copied verbatim from the reference pages so the output is visually
// consistent with them.
// ---------------------------------------------------------------------------
let idCounter = 0;
function genId() {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `block-${Date.now().toString(36)}-${idCounter.toString(36)}${rand}`;
}

const bpOf = (geom) => ({ mobile: {}, tablet: {}, desktop: { ...geom, hidden: false } });
const a11y = () => ({ role: '', altText: '', tabIndex: null, ariaLabel: '', ariaHidden: false });
const baseStyle = (over = {}) => ({
  zIndex: 1,
  opacity: 1,
  background: 'transparent',
  paddingTop: 0,
  borderColor: '#cbd5e1',
  borderStyle: 'solid',
  borderWidth: 0,
  paddingLeft: 0,
  borderRadius: 4,
  paddingRight: 0,
  paddingBottom: 0,
  ...over,
});
const wrap = (o) => ({ groupId: null, anchorId: '', fullWidth: false, ...o });

function makeHero(
  { headline, subheadline, ctaLabel, ctaHref, cta2Label, cta2Href, cta2Variant, bgImageUrl },
  geom
) {
  // Only emit CTA buttons when the spec supplies labels; a document with no
  // call-to-action must not gain a fabricated one. Hrefs default to '#'
  // placeholders (existing pages) but real links pass through verbatim.
  const ctas = [];
  if (ctaLabel) {
    ctas.push({
      href: ctaHref || '#',
      label: ctaLabel,
      variant: THEME.buttonVariant,
      labelTypographyStyleId: TYPO_ACTIVE.heroSub,
    });
  }
  if (cta2Label) {
    ctas.push({
      href: cta2Href || '#',
      label: cta2Label,
      variant: cta2Variant || THEME.buttonVariant,
      labelTypographyStyleId: TYPO_ACTIVE.heroSub,
    });
  }
  return wrap({
    bp: bpOf(geom),
    id: genId(),
    a11y: a11y(),
    name: 'Events hero',
    type: 'hero',
    style: {
      zIndex: 1,
      opacity: 1,
      background: 'var(--cb-color-primary, #0f172a)',
      paddingTop: 0,
      borderColor: '#cbd5e1',
      borderStyle: 'solid',
      borderWidth: 0,
      paddingLeft: 200,
      borderRadius: 0,
      paddingRight: 200,
      paddingBottom: 0,
    },
    locked: false,
    content: {
      ctas,
      bgType: 'image',
      bgColor: 'var(--cb-color-primary, #0f172a)',
      darkWash: 0.4,
      headline,
      alignment: 'left',
      fullBleed: true,
      textColor: 'var(--cb-color-on-primary, #ffffff)',
      bgImageUrl,
      bgVideoUrl: '',
      subheadline,
      headingLevel: 1,
      overlayAngle: 0,
      overlayStops: THEME.heroOverlay.stops.map((s) => ({ ...s })),
      overlayStyle: 'gradient',
      overlayToColor: '',
      overlayDirection: THEME.heroOverlay.direction,
      overlayFromColor: THEME.heroOverlay.fromColor,
      overlayToOpacity: 0,
      overlayFromOpacity: 1,
      headlineTypographyStyleId: TYPO_ACTIVE.heroHeadline,
      subheadlineTypographyStyleId: TYPO_ACTIVE.heroSub,
    },
  });
}

// Escape text destined for an HTML string so literal < > & from the source
// survive verbatim instead of being parsed away (fidelity requirement).
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function makeH2(text, geom, { center = false } = {}) {
  const align = center ? ' style="text-align: center;"' : '';
  return wrap({
    bp: bpOf(geom),
    id: genId(),
    a11y: a11y(),
    name: 'Text',
    type: 'text',
    style: baseStyle(),
    locked: false,
    content: {
      html: `<p${align}>${escHtml(text)}</p>`,
      colorRole: 'default',
      headingAs: '2',
      bulletIcon: '',
      bulletIconSize: null,
      bulletIconColor: '',
      bulletIconPadTop: null,
      characterSpacing: null,
      bulletIconPadLeft: null,
      typographyStyleId: TYPO_ACTIVE.h2,
      bulletIconPadRight: null,
      bulletIconPadBottom: null,
    },
  });
}

function makeH3(text, geom) {
  return wrap({
    bp: bpOf(geom),
    id: genId(),
    a11y: a11y(),
    name: 'Text',
    type: 'text',
    style: baseStyle(),
    locked: false,
    content: {
      html: `<p><span style="font-size: 28px;">${escHtml(text)}</span></p>`,
      colorRole: 'default',
      headingAs: '3',
      bulletIcon: '',
      bulletIconSize: null,
      bulletIconColor: '',
      bulletIconPadTop: null,
      characterSpacing: null,
      bulletIconPadLeft: null,
      typographyStyleId: TYPO_ACTIVE.h3,
      bulletIconPadRight: null,
      bulletIconPadBottom: null,
    },
  });
}

function makeBody(html, geom, { bullets = false } = {}) {
  const bulletFields = bullets
    ? { bulletIcon: 'fa-solid fa-arrow-right', bulletIconSize: 15, bulletIconColor: THEME.accent, bulletIconPadTop: 5 }
    : { bulletIcon: '', bulletIconSize: null, bulletIconColor: '', bulletIconPadTop: null };
  return wrap({
    bp: bpOf(geom),
    id: genId(),
    a11y: a11y(),
    name: 'Text',
    type: 'text',
    style: baseStyle(),
    locked: false,
    content: {
      html,
      colorRole: 'default',
      headingAs: '',
      ...bulletFields,
      characterSpacing: null,
      bulletIconPadLeft: null,
      typographyStyleId: TYPO_ACTIVE.body,
      bulletIconPadRight: null,
      bulletIconPadBottom: null,
    },
  });
}

function makeIntro(html, geom) {
  return wrap({
    bp: bpOf(geom),
    id: genId(),
    a11y: a11y(),
    name: 'Text',
    type: 'text',
    style: baseStyle(),
    locked: false,
    content: {
      html,
      colorRole: 'default',
      bulletIcon: '',
      bulletIconSize: null,
      bulletIconColor: '',
      bulletIconPadTop: null,
      characterSpacing: null,
      bulletIconPadLeft: null,
      bulletIconPadRight: null,
      bulletIconPadBottom: null,
    },
  });
}

function makeIcon(iconClass, geom, { iconSize = 30 } = {}) {
  return wrap({
    bp: bpOf(geom),
    id: genId(),
    a11y: a11y(),
    name: 'Image',
    type: 'image',
    style: baseStyle(),
    locked: false,
    content: {
      alt: '',
      src: '',
      href: '',
      iconSize,
      fullBleed: false,
      iconAlign: 'center',
      iconClass,
      iconColor: THEME.accent,
      objectFit: 'cover',
      heightMode: 'auto',
      heightValue: null,
    },
  });
}

// Logo lockup that sits ON TOP of the opening hero (top-right). White rounded
// chip so a (JPEG) logo reads cleanly over the dark-washed hero image; higher
// zIndex + emitted after the hero so it layers above it.
function makeLogo(src, geom) {
  return wrap({
    bp: bpOf(geom),
    id: genId(),
    a11y: a11y(),
    name: 'Logo',
    type: 'image',
    style: baseStyle({
      zIndex: 5,
      background: '#ffffff',
      borderRadius: 8,
      paddingTop: 10,
      paddingBottom: 10,
      paddingLeft: 14,
      paddingRight: 14,
    }),
    locked: false,
    content: {
      alt: 'Logo',
      src,
      href: '',
      iconSize: 50,
      fullBleed: false,
      iconAlign: 'center',
      iconClass: '',
      iconColor: THEME.accent,
      objectFit: 'contain',
      heightMode: 'auto',
      heightValue: null,
    },
  });
}

function makeDivider(geom) {
  return wrap({
    bp: bpOf(geom),
    id: genId(),
    a11y: a11y(),
    name: 'Divider',
    type: 'divider',
    style: baseStyle(),
    locked: false,
    content: { color: THEME.dividerColor, lineStyle: 'solid', thickness: 1 },
  });
}

function makeSection(geom) {
  return wrap({
    bp: bpOf(geom),
    id: genId(),
    a11y: a11y(),
    name: 'Section',
    type: 'section',
    style: baseStyle({ background: THEME.bandBg, paddingTop: 24, paddingLeft: 24, paddingRight: 24, paddingBottom: 24 }),
    locked: false,
    content: {
      bgType: 'color',
      maxWidth: 0,
      fullBleed: true,
      bgImageUrl: '',
      overlayType: 'solid',
      overlayAngle: 180,
      overlayColor: '#000000',
      overlayOpacity: 0.4,
      overlayToColor: '#000000',
      overlayBlendMode: 'normal',
      overlayEdgeColor: '#000000',
      overlayFromColor: '#000000',
      overlayToOpacity: 0,
      overlayCenterColor: '#000000',
      overlayEdgeOpacity: 0.6,
      overlayFromOpacity: 0.6,
      overlayCenterOpacity: 0,
    },
  });
}

function makeAccordion(items, geom) {
  return wrap({
    bp: bpOf(geom),
    id: genId(),
    a11y: a11y(),
    name: 'FAQ / Accordion',
    type: 'accordion',
    style: baseStyle(),
    locked: false,
    content: {
      items,
      itemGap: 20,
      expandOne: true,
      questionFontSize: 20,
    },
  });
}

// Card — matches the tenant's existing card blocks (white surface, subtle
// border + shadow, accent icon, card-heading typography). CTA is optional; when
// present it renders the theme button style, link "#".
function makeCard({ icon, heading, body, cta, ctaHref, imageUrl, anchorId }, geom) {
  return wrap({
    anchorId: anchorId || '',
    bp: bpOf(geom),
    id: genId(),
    a11y: a11y(),
    name: 'Card',
    type: 'card',
    style: {
      zIndex: 1,
      opacity: 1,
      background: 'var(--cb-color-surface, #ffffff)',
      paddingTop: 0,
      borderColor: 'var(--cb-color-border, #e2e8f0)',
      borderStyle: 'solid',
      borderWidth: 1,
      paddingLeft: 0,
      borderRadius: 8,
      paddingRight: 0,
      paddingBottom: 0,
    },
    locked: false,
    content: {
      body,
      shadow: 'md',
      ctaHref: ctaHref || '#',
      heading,
      ctaAlign: 'left',
      ctaLabel: cta || '',
      iconSize: 47,
      imageAlt: imageUrl ? heading || '' : '',
      imageUrl: imageUrl || '',
      highlight: true,
      iconAlign: 'center',
      iconClass: icon || '',
      iconColor: THEME.accent,
      ctaEnabled: !!cta,
      ctaVariant: THEME.buttonVariant,
      imageAlign: 'center',
      headingLevel: 4,
      headerSpacing: null,
      imageWidthPct: 100,
      contentPadding: 24,
      highlightColor: THEME.cardHighlight,
      imageDisplayMode: 'inline',
      headingTypographyStyleId: TYPO_ACTIVE.cardHeading,
    },
  });
}

// Standalone primary button (feature-panel / section CTAs). Link defaults to
// the "#" placeholder unless the spec supplies a real href.
function makeButton(label, geom, href) {
  return wrap({
    bp: bpOf(geom),
    id: genId(),
    a11y: a11y(),
    name: 'Button',
    type: 'button',
    style: baseStyle(),
    locked: false,
    content: {
      href: href || '#',
      icon: '',
      size: { fontSize: 20 },
      label,
      newTab: false,
      variant: THEME.buttonVariant,
      ariaLabel: '',
      sizeClass: 'lg',
      typographyStyleId: TYPO_ACTIVE.heroSub,
    },
  });
}

// Dashed "note" box — used for deferred/interactive surfaces (searchable member
// directory, video embed, searchable recipients table) that will be wired up
// later. Renders muted secondary text inside a dashed accent frame. The cleanup
// pass treats these dashed text boxes as sample/placeholder content.
function makeNote(html, geom) {
  return wrap({
    bp: bpOf(geom),
    id: genId(),
    a11y: a11y(),
    name: 'Text',
    type: 'text',
    style: baseStyle({
      background: '#ffffff',
      borderColor: THEME.accent,
      borderStyle: 'dashed',
      borderWidth: 1,
      borderRadius: 8,
      paddingTop: 20,
      paddingBottom: 20,
      paddingLeft: 24,
      paddingRight: 24,
    }),
    locked: false,
    content: {
      html,
      colorRole: 'secondary',
      headingAs: '',
      bulletIcon: '',
      bulletIconSize: null,
      bulletIconColor: '',
      bulletIconPadTop: null,
      characterSpacing: null,
      bulletIconPadLeft: null,
      typographyStyleId: TYPO_ACTIVE.body,
      bulletIconPadRight: null,
      bulletIconPadBottom: null,
    },
  });
}

// ---------------------------------------------------------------------------
// Layout engine. Canvas is 1200px wide. Blocks are absolutely positioned and
// clip overflow, so section heights are supplied generously by the spec.
// Ordering matters for stacking (equal z-index -> source order): the colour
// band block is emitted BEFORE its content so the content renders on top.
// ---------------------------------------------------------------------------
export const CANVAS_W = 1200;
export const MARGIN = 150;
export const CONTENT_W = CANVAS_W - MARGIN * 2; // 900
const COL_GAP = 60;
const COL_W = Math.floor((CONTENT_W - COL_GAP) / 2); // 420
const COL_LEFT_X = MARGIN;
const COL_RIGHT_X = MARGIN + COL_W + COL_GAP; // 630

export const HERO_H = 600;
export const CLOSING_HERO_H = 420;

function resolveTheme(theme) {
  if (theme && typeof theme === 'object') return theme;
  return THEMES[theme] || THEMES.bnms;
}

export function buildDesign(spec) {
  THEME = resolveTheme(spec.theme);
  TYPO_ACTIVE = spec.typo || TYPO;
  const topBlocks = [];
  const sectionBlocks = [];
  let y = 0;

  // Opening hero (full-bleed, full width).
  topBlocks.push(makeHero(spec.hero, { x: 0, y, w: CANVAS_W, h: HERO_H }));
  // Optional logo lockup on top of the opening hero, top-right. Emitted after
  // the hero (and with a higher zIndex) so it layers above the hero image. It
  // is an overlay — it does NOT advance the layout cursor `y`.
  if (THEME.logoUrl) {
    const logoW = 300;
    const logoH = 96;
    topBlocks.push(makeLogo(THEME.logoUrl, { x: CANVAS_W - logoW - 40, y: 32, w: logoW, h: logoH }));
  }
  y += HERO_H + 48;

  // Optional intro: centered icon + strapline + intro paragraphs. Icon and
  // strapline are each optional so a document with no strapline copy does not
  // gain a fabricated heading.
  if (spec.intro) {
    if (spec.intro.icon) {
      topBlocks.push(makeIcon(spec.intro.icon, { x: 528, y, w: 144, h: 136 }, { iconSize: 50 }));
      y += 136 + 12;
    }
    if (spec.intro.strapline) {
      topBlocks.push(makeH2(spec.intro.strapline, { x: MARGIN, y, w: CONTENT_W, h: 60 }, { center: true }));
      y += 60 + 12;
    }
    topBlocks.push(makeIntro(spec.intro.html, { x: MARGIN, y, w: CONTENT_W, h: spec.intro.h }));
    y += spec.intro.h + COL_GAP;
  }

  // Colour band wraps every content section.
  const bandTop = y;
  y += 56; // inner top padding

  for (const section of spec.sections) {
    if (section.heading) {
      sectionBlocks.push(makeH2(section.heading, { x: MARGIN, y, w: CONTENT_W, h: 60 }));
      y += 60 + 12;
      sectionBlocks.push(makeDivider({ x: MARGIN, y, w: 300, h: 24 }));
      y += 24 + 20;
    }

    if (section.type === 'columns') {
      const colTop = y;
      let maxColH = 0;
      const colX = [COL_LEFT_X, COL_RIGHT_X];
      section.columns.forEach((col, i) => {
        const x = colX[i];
        let cy = colTop;
        if (col.icon) {
          sectionBlocks.push(makeIcon(col.icon, { x, y: cy, w: 48, h: 64 }));
          cy += 64 + 12;
        }
        sectionBlocks.push(makeH3(col.h3, { x, y: cy, w: COL_W, h: 50 }));
        cy += 50 + 12;
        sectionBlocks.push(makeDivider({ x, y: cy, w: 260, h: 24 }));
        cy += 24 + 16;
        sectionBlocks.push(makeBody(col.html, { x, y: cy, w: COL_W, h: col.h }, { bullets: col.bullets !== false }));
        cy += col.h;
        maxColH = Math.max(maxColH, cy - colTop);
      });
      y = colTop + maxColH + 56;
    } else if (section.type === 'accordion') {
      // Accordion blocks are forced to height:auto on the public renderer and
      // grow the section/stage via the reflow context when items expand, so the
      // supplied height only needs to cover the collapsed baseline layout.
      const accH = section.h || 360;
      sectionBlocks.push(makeAccordion(section.items, { x: MARGIN, y, w: CONTENT_W, h: accH }));
      y += accH + 56;
    } else if (section.type === 'cards') {
      // Optional H3 sub-heading between the section heading and the cards
      // (e.g. sponsor tier labels).
      if (section.subheading) {
        sectionBlocks.push(makeH3(section.subheading, { x: MARGIN, y, w: CONTENT_W, h: 50 }));
        y += 50 + 16;
      }
      // Row(s) of cards, centred across the canvas. Cards break out wider than
      // the 900px text column, matching the tenant's existing card pages.
      const cols = section.columns || 3;
      const gap = 24;
      const cardW = cols === 4 ? 276 : cols === 3 ? 320 : Math.floor((CONTENT_W - (cols - 1) * gap) / cols);
      // Centre on the ACTUAL number of cards when there are fewer than a full
      // row, so e.g. a lone sponsor card doesn't sit off in the left column.
      const effCols = Math.max(1, Math.min(cols, section.cards.length));
      const rowW = effCols * cardW + (effCols - 1) * gap;
      const startX = Math.round((CANVAS_W - rowW) / 2);
      // Per-card heights are allowed (card.h); each row steps by its tallest
      // card so stacked single-column panels of differing length work.
      const rows = Math.ceil(section.cards.length / cols);
      let cy = y;
      for (let r = 0; r < rows; r += 1) {
        const rowCards = section.cards.slice(r * cols, r * cols + cols);
        const rowH = Math.max(...rowCards.map((card) => card.h || section.cardH || 340));
        rowCards.forEach((card, ci) => {
          const x = startX + ci * (cardW + gap);
          sectionBlocks.push(makeCard(card, { x, y: cy, w: cardW, h: card.h || rowH }));
        });
        cy += rowH + gap;
      }
      y = cy - gap + 56;
    } else if (section.type === 'placeholder') {
      // Deferred interactive surface (searchable member directory / video /
      // searchable table) — dashed note explaining what will render here.
      const noteH = section.h || 120;
      sectionBlocks.push(makeNote(section.note, { x: MARGIN, y, w: CONTENT_W, h: noteH }));
      y += noteH + 56;
    } else {
      // 'text' / 'feature' — body copy, optional CTA button(s) below.
      sectionBlocks.push(makeBody(section.html, { x: MARGIN, y, w: CONTENT_W, h: section.h }, { bullets: !!section.bullets }));
      y += section.h;
      const btnLabels = section.buttons || (section.cta ? [section.cta] : []);
      if (btnLabels.length) {
        y += 16;
        const bw = 340;
        const bgap = 20;
        const perRow = 2;
        btnLabels.forEach((btn, i) => {
          const r = Math.floor(i / perRow);
          const c = i % perRow;
          const label = typeof btn === 'string' ? btn : btn.label;
          const href = typeof btn === 'string' ? undefined : btn.href;
          sectionBlocks.push(makeButton(label, { x: MARGIN + c * (bw + bgap), y: y + r * (48 + 16), w: bw, h: 48 }, href));
        });
        const rows = Math.ceil(btnLabels.length / perRow);
        y += rows * 48 + (rows - 1) * 16;
      }
      y += 56;
    }
  }

  const bandBottom = y;
  y = bandBottom + 48;

  // Closing hero CTA — only when the spec supplies one. A document with no
  // closing call-to-action must not gain a fabricated section.
  const closingHero =
    spec.closingHero && String(spec.closingHero.headline || '').trim()
      ? makeHero(spec.closingHero, { x: 0, y, w: CANVAS_W, h: CLOSING_HERO_H })
      : null;

  // Emit band before its content so content renders on top.
  const band = makeSection({ x: 0, y: bandTop, w: CANVAS_W, h: bandBottom - bandTop });

  const children = [...topBlocks, band, ...sectionBlocks, ...(closingHero ? [closingHero] : [])];

  return {
    version: 1,
    root: {
      groups: [],
      guides: { vertical: [], horizontal: [] },
      sections: [{ id: 'root-section', children }],
      background: null,
    },
  };
}

// Convenience for the in-app "Create page from document" feature: build a
// tenant-neutral design (empty typography + CSS-variable theme) so the page
// adopts the current tenant's branding and default fonts.
export function buildNeutralDesign(spec) {
  return buildDesign({ ...spec, theme: NEUTRAL_THEME, typo: EMPTY_TYPO });
}

// ---------------------------------------------------------------------------
// Style extraction from an existing Canvas page.
//
// Reads a page's canvas_design and derives a theme object in the shape
// buildDesign consumes (accent / bandBg / dividerColor / cardHighlight /
// buttonVariant / heroOverlay / optional logoUrl) plus the typography-style ids
// used on that page, so the doc-import flow can reproduce a hand-built brand
// look ("seed page"). Any facet the source page does not define falls back to
// the neutral values, so extraction never yields a broken theme.
// ---------------------------------------------------------------------------

// Flatten every block in a design, defensively recursing into any nested
// `children` arrays (Canvas blocks live flat under root.sections[].children,
// but we recurse just in case).
function collectDesignBlocks(design) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.type && node.content) out.push(node);
    if (Array.isArray(node.children)) node.children.forEach(visit);
    if (Array.isArray(node.sections)) node.sections.forEach(visit);
  };
  const root = design && typeof design === 'object' ? design.root : null;
  if (root && Array.isArray(root.sections)) root.sections.forEach(visit);
  return out;
}

const isRealColor = (v) => typeof v === 'string' && v.trim() !== '';

export function extractThemeFromDesign(design) {
  const theme = {
    ...NEUTRAL_THEME,
    heroOverlay: {
      ...NEUTRAL_THEME.heroOverlay,
      stops: NEUTRAL_THEME.heroOverlay.stops.map((s) => ({ ...s })),
    },
  };
  const typo = { ...EMPTY_TYPO };

  const blocks = collectDesignBlocks(design);
  if (!blocks.length) return { theme, typo };

  // --- Hero: overlay gradient, hero typography, and CTA button variant. ---
  const hero = blocks.find((b) => b.type === 'hero');
  if (hero?.content) {
    const c = hero.content;
    if (isRealColor(c.headlineTypographyStyleId)) typo.heroHeadline = c.headlineTypographyStyleId;
    if (isRealColor(c.subheadlineTypographyStyleId)) typo.heroSub = c.subheadlineTypographyStyleId;
    const stops = Array.isArray(c.overlayStops) && c.overlayStops.length
      ? c.overlayStops.map((s) => ({
          color: isRealColor(s?.color) ? s.color : '#000000',
          opacity: typeof s?.opacity === 'number' ? s.opacity : 1,
          position: typeof s?.position === 'number' ? s.position : 0,
        }))
      : null;
    if (isRealColor(c.overlayDirection) || isRealColor(c.overlayFromColor) || stops) {
      theme.heroOverlay = {
        direction: isRealColor(c.overlayDirection) ? c.overlayDirection : NEUTRAL_THEME.heroOverlay.direction,
        fromColor: isRealColor(c.overlayFromColor) ? c.overlayFromColor : NEUTRAL_THEME.heroOverlay.fromColor,
        stops: stops || NEUTRAL_THEME.heroOverlay.stops.map((s) => ({ ...s })),
      };
    }
    const heroCtaVariant = Array.isArray(c.ctas) && c.ctas[0]?.variant;
    if (isRealColor(heroCtaVariant)) theme.buttonVariant = heroCtaVariant;
  }

  // --- Colour band background. ---
  const section = blocks.find((b) => b.type === 'section');
  if (isRealColor(section?.style?.background)) theme.bandBg = section.style.background;

  // --- Divider colour. ---
  const divider = blocks.find((b) => b.type === 'divider');
  if (isRealColor(divider?.content?.color)) theme.dividerColor = divider.content.color;

  // --- Card: highlight colour, icon accent, button variant, heading typo. ---
  const card = blocks.find((b) => b.type === 'card');
  if (card?.content) {
    if (isRealColor(card.content.highlightColor)) theme.cardHighlight = card.content.highlightColor;
    if (isRealColor(card.content.ctaVariant)) theme.buttonVariant = card.content.ctaVariant;
    if (isRealColor(card.content.headingTypographyStyleId)) typo.cardHeading = card.content.headingTypographyStyleId;
  }

  // --- Standalone button variant (overrides card/hero when present). ---
  const button = blocks.find((b) => b.type === 'button');
  if (isRealColor(button?.content?.variant)) theme.buttonVariant = button.content.variant;

  // --- Accent: first real colour among icon / bullet / card-icon colours. ---
  let accent = null;
  for (const b of blocks) {
    const c = b.content || {};
    if (b.type === 'image' && isRealColor(c.iconColor) && isRealColor(c.iconClass)) { accent = c.iconColor; break; }
    if (b.type === 'text' && isRealColor(c.bulletIconColor)) { accent = c.bulletIconColor; break; }
    if (b.type === 'card' && isRealColor(c.iconColor)) { accent = c.iconColor; break; }
  }
  if (isRealColor(accent)) theme.accent = accent;

  // --- Typography ids from text blocks (h2 / h3 / body). ---
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    const c = b.content || {};
    const styleId = c.typographyStyleId;
    if (!isRealColor(styleId)) continue;
    const headingAs = String(c.headingAs || '');
    if (headingAs === '2' && !typo.h2) typo.h2 = styleId;
    else if (headingAs === '3' && !typo.h3) typo.h3 = styleId;
    else if (headingAs === '' && !typo.body) typo.body = styleId;
  }

  // --- Optional logo lockup (image block with a real src). ---
  const logo = blocks.find(
    (b) => b.type === 'image' && isRealColor(b.content?.src) && (b.name === 'Logo' || !isRealColor(b.content?.iconClass))
  );
  if (logo && isRealColor(logo.content.src)) theme.logoUrl = logo.content.src;

  return { theme, typo };
}

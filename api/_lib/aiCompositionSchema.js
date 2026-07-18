/**
 * AI Composition document schema validator — Phase 0 DRAFT.
 *
 * Design doc: guides/ai-design-studio-architecture.md (§3, §4, §7).
 * This module is inert in Phase 0: nothing imports it in production yet.
 * Later phases wire it into the generation pipeline (stage 5/7) and the
 * patch-application path so invalid LLM output is rejected before it can
 * ever become the current composition.
 *
 * Pure JS, no dependencies. `validateComposition(doc)` and
 * `validatePatch(patch)` return `{ ok: boolean, errors: string[] }`.
 */

export const AI_COMPOSITION_SCHEMA_VERSION = 1;

export const COMPOSITION_TYPES = ['section', 'multi_section_page'];
export const COMPOSITION_STATUSES = ['draft', 'ready_for_review', 'approved'];
export const AI_BREAKPOINTS = ['desktop', 'tablet', 'mobile'];

/** Spec §6 element types (v1). Extensible: additions bump nothing; removals never happen. */
export const ELEMENT_TYPES = [
  'section_background',
  'container',
  'group',
  'heading',
  'paragraph',
  'label',
  'caption',
  'image',
  'generated_illustration',
  'icon',
  'button',
  'text_link',
  'shape',
  'line',
  'connector',
  'background',
  'overlay',
  'card',
  'statistic',
  'timeline_item',
  'process_step',
  'repeating_item',
  'comparison_item',
  'simple_chart',
  'structured_infographic',
  'svg_decorative',
  'iconnect_action',
  'canvas_component_placeholder',
];

const CONTAINER_TYPES = new Set(['container', 'group', 'card', 'overlay', 'structured_infographic']);

/**
 * Approved iConnect functional components the AI may RECOMMEND and POSITION
 * via canvas_component_placeholder elements (spec §8/§32 Phase 5). The AI is
 * responsible for presentation only — a placeholder always resolves to the
 * real, existing component at render time; the AI never recreates behaviour.
 */
export const FUNCTIONAL_COMPONENT_KEYS = [
  'form',
  'event_registration',
  'event_list',
  // NOTE: 'membership_application' is intentionally NOT in this list — there
  // is no dedicated canvas block for it yet, and an unmapped placeholder
  // renders nothing publicly. Re-add once a real block exists.
  'news_listing',
  'resource_list',
  'member_directory',
  'login',
];

/** Spec §16 link kinds. Internal destinations are record IDs — never raw URLs. */
export const LINK_KINDS = [
  'page',
  'event_registration',
  'membership_application',
  'form',
  'document',
  'external',
  'email',
  'tel',
  'anchor',
  'iconnect_action',
];

const LINK_REQUIRED_FIELD = {
  page: 'pageId',
  event_registration: 'eventId',
  membership_application: null, // optional tierId
  form: 'formId',
  document: 'fileId',
  external: 'url',
  email: 'address',
  tel: 'number',
  anchor: 'anchorId',
  iconnect_action: 'actionKey',
};

// Internal destinations are record IDs only (spec §16) — enforce the ID
// SHAPE, not just "not a URL", so junk like `javascript:…` never persists.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_KEY_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEL_RE = /^\+?[\d\s().-]{3,20}$/;

const LINK_FIELD_FORMAT = {
  pageId: UUID_RE,
  eventId: UUID_RE,
  formId: UUID_RE,
  fileId: UUID_RE,
  tierId: UUID_RE,
  anchorId: SLUG_KEY_RE,
  actionKey: SLUG_KEY_RE,
  address: EMAIL_RE,
  number: TEL_RE,
};

export const PROTECTED_VALUE_KINDS = [
  'link', 'form_ref', 'event_ref', 'date', 'price', 'statistic', 'name',
  'sponsor_logo', 'legal_text', 'a11y_text', 'binding',
];

/**
 * CSS property allowlist (Decision D3). Element `style` objects may use only
 * these keys. Values are additionally sanitized per-property at render time;
 * validation here rejects unknown keys and obviously unsafe values.
 */
export const CSS_PROPERTY_ALLOWLIST = new Set([
  // colour & background
  'color', 'backgroundColor', 'backgroundImage', // gradients only (validated)
  // typography
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
  'letterSpacing', 'textAlign', 'textTransform', 'textDecoration',
  // box
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
  'borderRadius', 'boxShadow', 'outline',
  // layout hints inside elements
  'gap', 'alignItems', 'justifyContent', 'flexDirection', 'flexWrap',
  'gridTemplateColumns', 'aspectRatio',
  // visual
  'opacity', 'overflow', 'clipPath', 'filter', 'mixBlendMode',
  'transform', // rotate()/translate()/scale() subset, sanitized at render
  'objectFit', 'objectPosition',
]);

const UNSAFE_CSS_VALUE_RE = /url\s*\(|expression\s*\(|@import|javascript:|!important|var\s*\(/i;
// backgroundImage may only carry gradients.
const GRADIENT_ONLY_RE = /^(linear|radial|conic)-gradient\(/i;
// transform may only compose rotate/translate/scale functions (Decision D3).
const TRANSFORM_SAFE_RE = /^(\s*(rotate|rotateZ|translate|translateX|translateY|scale|scaleX|scaleY)\([^()]*\)\s*)+$/i;

const UNSAFE_HTML_RE = /<\s*(script|style|iframe|object|embed|link|meta|form|input|textarea|select)\b|on[a-z]+\s*=|javascript:|srcdoc\s*=/i;

const FRAME_MODES = ['absolute', 'flow', 'flex', 'grid'];

export const PATCH_OPS = [
  'update_content',
  'update_link',
  'update_style',
  'replace_asset',
  'update_data',
  'insert_element',
  'remove_element',
  'insert_section',
  'remove_section',
  'reorder_sections',
  'replace_section',
];

// ---------------------------------------------------------------------------

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function looksLikeUrl(v) {
  return typeof v === 'string' && /^(https?:)?\/\//i.test(v);
}

export function validateLinkRef(link, path, errors) {
  if (!isPlainObject(link)) {
    errors.push(`${path}: link must be an object`);
    return;
  }
  if (!LINK_KINDS.includes(link.kind)) {
    errors.push(`${path}: unknown link kind "${link.kind}"`);
    return;
  }
  const required = LINK_REQUIRED_FIELD[link.kind];
  if (required && !isNonEmptyString(link[required])) {
    errors.push(`${path}: link kind "${link.kind}" requires "${required}"`);
  }
  if (link.kind === 'external') {
    if (!/^https?:\/\//i.test(link.url || '')) {
      errors.push(`${path}: external link url must be http(s)`);
    }
  } else {
    // Internal destinations are record IDs — never raw URLs (spec §16).
    for (const [k, v] of Object.entries(link)) {
      if (k === 'kind') continue;
      if (looksLikeUrl(v)) {
        errors.push(`${path}: internal link kind "${link.kind}" must not carry a raw URL (found in "${k}")`);
        continue;
      }
      const format = LINK_FIELD_FORMAT[k];
      if (format && typeof v === 'string' && !format.test(v)) {
        errors.push(`${path}: link field "${k}" is not a valid identifier`);
      }
    }
  }
}

/** Units accepted in `{ value, unit }` style objects. */
export const CSS_VALUE_UNITS = new Set(['px', '%', 'em', 'rem', 'vw', 'vh']);

function validateStyle(style, path, errors) {
  if (style === undefined) return;
  if (!isPlainObject(style)) {
    errors.push(`${path}: style must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(style)) {
    if (!CSS_PROPERTY_ALLOWLIST.has(key)) {
      errors.push(`${path}: style property "${key}" is not in the allowlist`);
      continue;
    }
    // Structured `{ value, unit }` objects: validate shape, never String()
    // them (that yields "[object Object]" which slips past the regexes).
    if (isPlainObject(value)) {
      if (!Number.isFinite(Number(value.value))
        || !CSS_VALUE_UNITS.has(String(value.unit ?? 'px'))) {
        errors.push(`${path}: style property "${key}" object value must be { value: number, unit: ${[...CSS_VALUE_UNITS].join('|')} }`);
      }
      continue;
    }
    if (Array.isArray(value)) {
      errors.push(`${path}: style property "${key}" has an invalid value`);
      continue;
    }
    const str = String(value ?? '');
    if (UNSAFE_CSS_VALUE_RE.test(str)) {
      errors.push(`${path}: style property "${key}" has an unsafe value`);
    }
    if (key === 'backgroundImage' && !GRADIENT_ONLY_RE.test(str.trim())) {
      errors.push(`${path}: backgroundImage may only be a gradient`);
    }
    if (key === 'transform' && !TRANSFORM_SAFE_RE.test(str.trim())) {
      errors.push(`${path}: transform may only use rotate/translate/scale functions`);
    }
  }
}

/** Asset generation lifecycle states (Phase 3). `failed` keeps the element in
 * the document — one failed image never discards the run (spec §30). */
export const ASSET_STATUSES = ['ready', 'pending', 'failed'];

function validateFocalPoint(fp, path, errors) {
  if (fp === undefined) return;
  if (!isPlainObject(fp)
    || typeof fp.x !== 'number' || typeof fp.y !== 'number'
    || fp.x < 0 || fp.x > 100 || fp.y < 0 || fp.y > 100) {
    errors.push(`${path}: focalPoint must be { x, y } percentages 0–100`);
  }
}

function validateAssetRef(asset, path, errors) {
  if (asset === undefined) return;
  if (!isPlainObject(asset)) {
    errors.push(`${path}: asset must be an object`);
    return;
  }
  if (asset.status !== undefined && !ASSET_STATUSES.includes(asset.status)) {
    errors.push(`${path}: unknown asset status "${asset.status}"`);
  }
  const pendingOrFailed = asset.status === 'pending' || asset.status === 'failed';
  if (!pendingOrFailed && !isNonEmptyString(asset.fileRepositoryId)) {
    errors.push(`${path}: asset.fileRepositoryId is required`);
  }
  if (asset.altText !== undefined && typeof asset.altText !== 'string') {
    errors.push(`${path}: asset.altText must be a string`);
  }
  validateFocalPoint(asset.focalPoint, `${path}.focalPoint`, errors);
  if (asset.crop !== undefined) {
    if (!isPlainObject(asset.crop)) {
      errors.push(`${path}: asset.crop must be an object`);
    } else if (asset.crop.aspectRatio !== undefined
      && !/^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/.test(String(asset.crop.aspectRatio))) {
      errors.push(`${path}: asset.crop.aspectRatio must look like "16 / 9"`);
    }
  }
  if (asset.mobile !== undefined) {
    if (!isPlainObject(asset.mobile) || !isNonEmptyString(asset.mobile.fileRepositoryId)) {
      errors.push(`${path}: asset.mobile requires fileRepositoryId`);
    }
  }
}

/** Structured image-generation brief (spec §19). Carried on image /
 * generated_illustration elements until the asset stage resolves them. */
export const IMAGE_BRIEF_STRING_FIELDS = [
  'subject', 'style', 'placement', 'palette', 'avoid',
  'accessibilityDescription', 'mobileCrop',
];

export function validateImageBrief(brief, path, errors) {
  if (brief === undefined) return;
  if (!isPlainObject(brief)) {
    errors.push(`${path}: imageBrief must be an object`);
    return;
  }
  if (!isNonEmptyString(brief.subject)) {
    errors.push(`${path}: imageBrief.subject is required`);
  }
  for (const key of IMAGE_BRIEF_STRING_FIELDS) {
    if (brief[key] !== undefined && typeof brief[key] !== 'string') {
      errors.push(`${path}: imageBrief.${key} must be a string`);
    }
  }
  if (brief.aspectRatio !== undefined
    && !/^(square|landscape|portrait)$/.test(String(brief.aspectRatio))) {
    errors.push(`${path}: imageBrief.aspectRatio must be square, landscape or portrait`);
  }
  validateFocalPoint(brief.focalPoint, `${path}.focalPoint`, errors);
  // Spec §19/§20 factual-text rule: essential/factual text is never rendered
  // inside generated raster imagery. Text overlays may be decorative only.
  if (brief.textOverlay !== undefined) {
    if (typeof brief.textOverlay !== 'string') {
      errors.push(`${path}: imageBrief.textOverlay must be a string`);
    } else if (/\d/.test(brief.textOverlay)) {
      errors.push(`${path}: imageBrief.textOverlay must not contain numbers or factual values — render those as real text elements`);
    }
  }
}

/** Element types whose values are factual and must stay structured text
 * (spec §20) — never delegated to generated raster imagery. */
export const FACTUAL_ELEMENT_TYPES = ['statistic', 'simple_chart', 'comparison_item'];

function validateElement(el, path, ctx) {
  const { errors, elementIds } = ctx;
  if (!isPlainObject(el)) {
    errors.push(`${path}: element must be an object`);
    return;
  }
  if (!isNonEmptyString(el.id)) {
    errors.push(`${path}: element id is required`);
  } else if (elementIds.has(el.id)) {
    errors.push(`${path}: duplicate element id "${el.id}"`);
  } else {
    elementIds.add(el.id);
  }
  if (!ELEMENT_TYPES.includes(el.type)) {
    errors.push(`${path}: unknown element type "${el.type}"`);
  }
  if (el.type === 'heading' && el.role !== undefined && !/^h[1-6]$/.test(el.role)) {
    errors.push(`${path}: heading role must be h1–h6`);
  }
  if (el.content !== undefined) {
    if (!isPlainObject(el.content)) {
      errors.push(`${path}: content must be an object`);
    } else if (typeof el.content.html === 'string' && UNSAFE_HTML_RE.test(el.content.html)) {
      errors.push(`${path}: content.html contains disallowed markup`);
    }
  }
  if (el.link !== undefined) validateLinkRef(el.link, `${path}.link`, errors);
  validateAssetRef(el.asset, `${path}.asset`, errors);
  validateImageBrief(el.imageBrief, `${path}.imageBrief`, errors);
  validateStyle(el.style, `${path}.style`, errors);
  if ((el.type === 'image' || el.type === 'generated_illustration')
    && !isPlainObject(el.asset) && !isPlainObject(el.imageBrief)) {
    errors.push(`${path}: ${el.type} requires an asset reference or an imageBrief`);
  }
  // Factual-text rule (spec §20): factual element types must carry structured
  // data rendered as real text/SVG — they may never delegate their values to
  // a generated raster image.
  if (FACTUAL_ELEMENT_TYPES.includes(el.type)) {
    if (el.imageBrief !== undefined || isPlainObject(el.asset)) {
      errors.push(`${path}: ${el.type} is factual — values must be structured data, never a generated image`);
    }
    if (!isPlainObject(el.data)) {
      errors.push(`${path}: ${el.type} requires a structured data object`);
    } else if (el.type === 'statistic' && el.data.value === undefined) {
      errors.push(`${path}: statistic requires data.value`);
    } else if (el.type === 'simple_chart') {
      const series = el.data.items || el.data.series || el.data.points;
      if (!Array.isArray(series) || series.length === 0) {
        errors.push(`${path}: simple_chart requires a data.items array of structured values`);
      }
    }
  }
  // Functional-component placeholders (spec §8, Phase 5): the AI positions an
  // approved iConnect component — it never recreates its behaviour. The
  // placeholder carries only a componentKey plus an optional record reference.
  if (el.type === 'canvas_component_placeholder') {
    if (!isPlainObject(el.data) || !FUNCTIONAL_COMPONENT_KEYS.includes(el.data.componentKey)) {
      errors.push(`${path}: canvas_component_placeholder requires data.componentKey (one of ${FUNCTIONAL_COMPONENT_KEYS.join(', ')})`);
    } else {
      if (el.data.recordId !== undefined
        && !(typeof el.data.recordId === 'string' && UUID_RE.test(el.data.recordId))) {
        errors.push(`${path}: canvas_component_placeholder data.recordId must be a record UUID`);
      }
      if (el.data.recordSlug !== undefined
        && !(typeof el.data.recordSlug === 'string' && SLUG_KEY_RE.test(el.data.recordSlug))) {
        errors.push(`${path}: canvas_component_placeholder data.recordSlug is not a valid slug`);
      }
      if (el.data.label !== undefined && typeof el.data.label !== 'string') {
        errors.push(`${path}: canvas_component_placeholder data.label must be a string`);
      }
    }
    if (el.imageBrief !== undefined || isPlainObject(el.asset)) {
      errors.push(`${path}: canvas_component_placeholder may not carry imagery — the real component renders itself`);
    }
  }
  if (el.type === 'svg_decorative') {
    const svg = el.svg || {};
    if (!isNonEmptyString(svg.d) && !isNonEmptyString(svg.paths?.[0]?.d)) {
      errors.push(`${path}: svg_decorative requires a path definition`);
    }
    if (UNSAFE_HTML_RE.test(JSON.stringify(svg))) {
      errors.push(`${path}: svg_decorative contains disallowed markup`);
    }
  }
  if (el.children !== undefined) {
    if (!CONTAINER_TYPES.has(el.type)) {
      errors.push(`${path}: element type "${el.type}" cannot have children`);
    } else if (!Array.isArray(el.children)) {
      errors.push(`${path}: children must be an array`);
    } else {
      el.children.forEach((child, i) => validateElement(child, `${path}.children[${i}]`, ctx));
    }
  }
}

function validateSection(section, index, ctx) {
  const { errors } = ctx;
  const path = `sections[${index}]`;
  if (!isPlainObject(section)) {
    errors.push(`${path}: section must be an object`);
    return;
  }
  if (!isNonEmptyString(section.id)) errors.push(`${path}: section id is required`);
  if (section.type !== 'ai_section') errors.push(`${path}: section type must be "ai_section"`);
  if (!Array.isArray(section.elements)) {
    errors.push(`${path}: elements must be an array`);
    return;
  }
  section.elements.forEach((el, i) => validateElement(el, `${path}.elements[${i}]`, ctx));

  // readingOrder is mandatory and must cover top-level element ids exactly once.
  const topIds = section.elements.filter(isPlainObject).map((e) => e.id).filter(Boolean);
  if (!Array.isArray(section.readingOrder)) {
    errors.push(`${path}: readingOrder is required`);
  } else {
    const ro = section.readingOrder;
    const roSet = new Set(ro);
    if (roSet.size !== ro.length) errors.push(`${path}: readingOrder has duplicates`);
    for (const id of topIds) {
      if (!roSet.has(id)) errors.push(`${path}: readingOrder is missing element "${id}"`);
    }
    for (const id of ro) {
      if (!topIds.includes(id)) errors.push(`${path}: readingOrder references unknown element "${id}"`);
    }
  }
}

function validateFrame(frame, path, errors) {
  if (!isPlainObject(frame)) {
    errors.push(`${path}: frame must be an object`);
    return;
  }
  if (frame.mode !== undefined && !FRAME_MODES.includes(frame.mode)) {
    errors.push(`${path}: unknown frame mode "${frame.mode}"`);
  }
  for (const key of ['x', 'y', 'w', 'h', 'minH', 'maxW', 'z', 'rotation', 'opacity']) {
    if (frame[key] !== undefined && frame[key] !== null && typeof frame[key] !== 'number') {
      errors.push(`${path}: frame.${key} must be a number or null`);
    }
  }
  if (frame.visible !== undefined && typeof frame.visible !== 'boolean') {
    errors.push(`${path}: frame.visible must be a boolean`);
  }
}

function validateLayouts(doc, ctx) {
  const { errors, elementIds } = ctx;
  const layouts = doc.layouts;
  if (!isPlainObject(layouts)) {
    errors.push('layouts must be an object');
    return;
  }
  for (const bp of Object.keys(layouts)) {
    if (!AI_BREAKPOINTS.includes(bp)) {
      errors.push(`layouts: unknown breakpoint "${bp}"`);
      continue;
    }
    const map = layouts[bp];
    if (!isPlainObject(map)) {
      errors.push(`layouts.${bp} must be an object`);
      continue;
    }
    for (const [elementId, frame] of Object.entries(map)) {
      if (!elementIds.has(elementId)) {
        errors.push(`layouts.${bp}: frame references unknown element "${elementId}"`);
      }
      validateFrame(frame, `layouts.${bp}.${elementId}`, errors);
    }
  }
  // Desktop frames are mandatory for every element (tablet/mobile inherit).
  const desktop = isPlainObject(layouts.desktop) ? layouts.desktop : {};
  for (const id of ctx.elementIds) {
    if (!(id in desktop)) {
      errors.push(`layouts.desktop: missing frame for element "${id}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Geometry & hierarchy validation (Task: fix schema/hierarchy/rendering).
// Overrides are PARTIAL by design, so completeness is checked on the
// EFFECTIVE merged frame per breakpoint (desktop → tablet → mobile), never
// on a raw override object.
// ---------------------------------------------------------------------------

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

function mergeEffectiveFrame(base, override) {
  if (!isPlainObject(override)) return base || null;
  const merged = { ...(base || {}) };
  for (const [k, v] of Object.entries(override)) {
    if (v !== undefined) merged[k] = v;
  }
  return merged;
}

/** Effective frame for an element at a breakpoint (tablet/mobile inherit). */
export function effectiveFrame(layouts, elementId, bp) {
  if (!isPlainObject(layouts)) return null;
  const desktop = isPlainObject(layouts.desktop) ? layouts.desktop[elementId] : null;
  if (bp === 'desktop') return isPlainObject(desktop) ? desktop : null;
  const tablet = mergeEffectiveFrame(
    isPlainObject(desktop) ? desktop : null,
    isPlainObject(layouts.tablet) ? layouts.tablet[elementId] : null,
  );
  if (bp === 'tablet') return tablet;
  return mergeEffectiveFrame(
    tablet,
    isPlainObject(layouts.mobile) ? layouts.mobile[elementId] : null,
  );
}

/** Map of every element id → { el, parent } (parent = containing element or null). */
function collectElementTree(doc) {
  const byId = new Map();
  for (const section of Array.isArray(doc.sections) ? doc.sections : []) {
    if (!isPlainObject(section) || !Array.isArray(section.elements)) continue;
    const walk = (el, parent) => {
      if (!isPlainObject(el) || !isNonEmptyString(el.id)) return;
      if (!byId.has(el.id)) byId.set(el.id, { el, parent });
      if (Array.isArray(el.children)) el.children.forEach((c) => walk(c, el));
    };
    section.elements.forEach((el) => walk(el, null));
  }
  return byId;
}

function validateGeometry(doc, ctx) {
  const { errors } = ctx;
  const layouts = doc.layouts;
  if (!isPlainObject(layouts)) return;
  const byId = collectElementTree(doc);

  for (const [id, { el, parent }] of byId) {
    for (const bp of AI_BREAKPOINTS) {
      // Only re-check tablet/mobile when that layer actually overrides this
      // element or its parent — otherwise the desktop report already covers it.
      if (bp !== 'desktop') {
        const layer = isPlainObject(layouts[bp]) ? layouts[bp] : null;
        const overridden = layer && (isPlainObject(layer[id])
          || (parent && isPlainObject(layer[parent.id])));
        if (!overridden) continue;
      }
      const eff = effectiveFrame(layouts, id, bp);
      if (!isPlainObject(eff) || eff.visible === false) continue;
      if (eff.mode === 'absolute') {
        // Absolute frames must be renderable: numeric x/y and a positive
        // width. Height may be null/absent (content height) or minH-driven.
        if (!isFiniteNum(eff.x) || !isFiniteNum(eff.y)) {
          errors.push(`layouts (${bp}): absolute frame for "${id}" requires numeric x and y (null/missing is not renderable)`);
        }
        if (!isFiniteNum(eff.w) || eff.w <= 0) {
          errors.push(`layouts (${bp}): absolute frame for "${id}" requires a positive numeric w`);
        }
        if (isFiniteNum(eff.h) && eff.h <= 0 && !isFiniteNum(eff.minH)) {
          errors.push(`layouts (${bp}): absolute frame for "${id}" has zero/negative height — use a positive h, a minH, or h: null for content height`);
        }
      }
      // Children of flex/grid containers participate in that layout — they
      // may never opt out into absolute positioning.
      if (parent) {
        const pf = effectiveFrame(layouts, parent.id, bp);
        if (isPlainObject(pf) && (pf.mode === 'flex' || pf.mode === 'grid')
          && eff.mode === 'absolute') {
          errors.push(`layouts (${bp}): "${id}" is absolute inside ${pf.mode} container "${parent.id}" — children of flex/grid containers must not be absolute`);
        }
      }
    }
    // A flex/grid container with nothing inside renders as dead space.
    if (CONTAINER_TYPES.has(el.type)) {
      const kids = Array.isArray(el.children)
        ? el.children.filter((c) => isPlainObject(c)).length : 0;
      if (kids === 0) {
        const df = effectiveFrame(layouts, id, 'desktop');
        if (isPlainObject(df) && (df.mode === 'flex' || df.mode === 'grid')) {
          errors.push(`container "${id}" is ${df.mode} but has no children`);
        }
      }
    }
  }

  // Absolute sections must resolve to a positive height on every breakpoint —
  // otherwise the whole section renders 0px tall and everything overlaps.
  (Array.isArray(doc.sections) ? doc.sections : []).forEach((section, si) => {
    const ids = collectSectionElementIds(section);
    if (!ids.length) return;
    for (const bp of AI_BREAKPOINTS) {
      let sawAbsolute = false;
      let sawContentHeight = false;
      let maxBottom = 0;
      for (const id of ids) {
        const eff = effectiveFrame(layouts, id, bp);
        if (!isPlainObject(eff) || eff.mode !== 'absolute' || eff.visible === false) continue;
        sawAbsolute = true;
        const h = isFiniteNum(eff.h) ? eff.h : (isFiniteNum(eff.minH) ? eff.minH : null);
        if (h === null) sawContentHeight = true; // content decides — can't be judged statically
        const y = isFiniteNum(eff.y) ? eff.y : 0;
        maxBottom = Math.max(maxBottom, y + (h ?? 0));
      }
      if (sawAbsolute && !sawContentHeight && maxBottom <= 0) {
        errors.push(`sections[${si}] (${bp}): absolute layout resolves to zero height — visible absolute frames must produce a positive section height`);
      }
    }
  });
}

function validateProtectedValues(doc, ctx) {
  const { errors, elementIds } = ctx;
  if (doc.protectedValues === undefined) return;
  if (!Array.isArray(doc.protectedValues)) {
    errors.push('protectedValues must be an array');
    return;
  }
  doc.protectedValues.forEach((pv, i) => {
    const path = `protectedValues[${i}]`;
    if (!isPlainObject(pv)) {
      errors.push(`${path}: must be an object`);
      return;
    }
    if (!PROTECTED_VALUE_KINDS.includes(pv.kind)) {
      errors.push(`${path}: unknown kind "${pv.kind}"`);
    }
    if (!isNonEmptyString(pv.elementId) || !elementIds.has(pv.elementId)) {
      errors.push(`${path}: elementId must reference an element in the document`);
    }
    if (!isNonEmptyString(pv.path)) {
      errors.push(`${path}: path is required`);
    }
  });
}

/**
 * Validate a full AI Composition document.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateComposition(doc) {
  const errors = [];
  if (!isPlainObject(doc)) {
    return { ok: false, errors: ['document must be an object'] };
  }
  if (doc.schemaVersion !== AI_COMPOSITION_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion "${doc.schemaVersion}" (expected ${AI_COMPOSITION_SCHEMA_VERSION})`);
  }
  if (!isNonEmptyString(doc.id)) errors.push('id is required');
  if (!isNonEmptyString(doc.name)) errors.push('name is required');
  if (!COMPOSITION_TYPES.includes(doc.compositionType)) {
    errors.push(`compositionType must be one of ${COMPOSITION_TYPES.join(', ')}`);
  }
  if (doc.status !== undefined && !COMPOSITION_STATUSES.includes(doc.status)) {
    errors.push(`unknown status "${doc.status}"`);
  }
  if (!Array.isArray(doc.sections) || doc.sections.length === 0) {
    errors.push('sections must be a non-empty array');
    return { ok: false, errors };
  }
  if (doc.compositionType === 'section' && doc.sections.length !== 1) {
    errors.push('compositionType "section" must contain exactly one section');
  }

  const ctx = { errors, elementIds: new Set() };
  const sectionIds = new Set();
  doc.sections.forEach((section, i) => {
    if (isPlainObject(section) && isNonEmptyString(section.id)) {
      if (sectionIds.has(section.id)) errors.push(`sections[${i}]: duplicate section id "${section.id}"`);
      sectionIds.add(section.id);
    }
    validateSection(section, i, ctx);
  });

  validateLayouts(doc, ctx);
  validateGeometry(doc, ctx);
  validateProtectedValues(doc, ctx);

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Mechanical repair pass (generation self-healing)
// ---------------------------------------------------------------------------

/** Collect every element id in a section, including nested children. */
function collectSectionElementIds(section, out = []) {
  if (!isPlainObject(section) || !Array.isArray(section.elements)) return out;
  const walk = (el) => {
    if (!isPlainObject(el)) return;
    if (isNonEmptyString(el.id)) out.push(el.id);
    if (Array.isArray(el.children)) el.children.forEach(walk);
  };
  section.elements.forEach(walk);
  return out;
}

/** Max synthesized frames per section: small fractions only — a section
 * missing most of its frames is genuinely broken and must still fail. */
const FRAME_REPAIR_CAP = (elementCount) => Math.max(2, Math.ceil(elementCount * 0.25));

/** Max non-container parents whose children we hoist per section. More than
 * this means the model produced a wholly different structure — fail it. */
const NEST_HOIST_CAP = 3;

/**
 * Repair pass 0 — invalid nesting. Two mechanical slips (seen verbatim in
 * failed production jobs, e.g. a `background` element wrapping the whole
 * section's content):
 *
 *   a. Non-container elements carrying an EMPTY `children: []` — the key is
 *      stripped (nothing is lost).
 *   b. Non-container elements carrying REAL children — the children are
 *      hoisted out, spliced immediately after the ex-parent in the same
 *      list, in document order, ids/content/frames untouched. The ex-parent
 *      stays as a childless element. Capped at NEST_HOIST_CAP parents per
 *      section; beyond that NO hoisting happens in the section so it still
 *      fails validation (empty-children stripping — harmless — still runs).
 *
 * Depth-first, so nested slips inside legitimate containers are fixed too.
 */
function repairSectionNesting(section, sectionIndex, repairs) {
  if (!isPlainObject(section) || !Array.isArray(section.elements)) return;
  // First count how many parents would need hoisting — over the cap, do nothing.
  let hoistParents = 0;
  const count = (el) => {
    if (!isPlainObject(el) || !Array.isArray(el.children)) return;
    el.children.forEach(count);
    if (!CONTAINER_TYPES.has(el.type) && el.children.length > 0) hoistParents += 1;
  };
  section.elements.forEach(count);
  const hoistAllowed = hoistParents <= NEST_HOIST_CAP;

  const label = (el) => (isNonEmptyString(el.id) ? `"${el.id}"` : `type "${el.type}"`);
  const walkList = (list) => {
    for (let i = 0; i < list.length; i += 1) {
      const el = list[i];
      if (!isPlainObject(el) || !Array.isArray(el.children)) continue;
      walkList(el.children); // depth-first: fix grandchildren before hoisting
      if (CONTAINER_TYPES.has(el.type)) continue;
      if (el.children.length === 0) {
        delete el.children;
        repairs.push(`sections[${sectionIndex}]: removed empty children from non-container ${label(el)}`);
      } else if (hoistAllowed) {
        const kids = el.children;
        delete el.children;
        list.splice(i + 1, 0, ...kids);
        repairs.push(`sections[${sectionIndex}]: hoisted ${kids.length} children out of non-container ${label(el)}`);
      }
    }
  };
  walkList(section.elements);
}

/**
 * Deterministically repair the two purely MECHANICAL validation failure
 * classes the document LLM commonly slips on (Task: auto-repair):
 *
 * 1. `readingOrder is missing element "<id>"` — top-level element ids the
 *    model created but forgot to list. Missing ids are APPENDED in document
 *    order; existing entries are never dropped or reordered. A wholly absent
 *    readingOrder is created from document order.
 * 2. `layouts.desktop: missing frame for element "<id>"` — synthesized
 *    safely: inherited from a tablet/mobile frame when the model supplied
 *    one, else stacked below the section's last absolutely-framed element,
 *    else `{ mode: 'flow' }`. Capped per section (FRAME_REPAIR_CAP) so a
 *    document missing most of its frames still fails validation.
 *
 * Pure and content-preserving: never mutates the input, never touches
 * element content, protected values, or EXISTING frames, and never removes
 * anything — genuinely invalid output (unknown refs, duplicates, unsafe
 * markup) still fails `validateComposition` afterwards.
 *
 * @returns {{ doc: object, repairs: string[] }} repaired copy + audit trail
 *          (returns the ORIGINAL doc untouched when no repairs apply).
 */
export function repairComposition(doc) {
  const repairs = [];
  if (!isPlainObject(doc) || !Array.isArray(doc.sections)) return { doc, repairs };
  const out = JSON.parse(JSON.stringify(doc));

  // --- 0. invalid nesting (strip empty children / hoist real children) ---
  // Runs FIRST so the readingOrder pass below sees hoisted ids at top level
  // and previously "unknown" readingOrder refs now resolve.
  out.sections.forEach((section, i) => repairSectionNesting(section, i, repairs));

  // --- 1. readingOrder ---
  out.sections.forEach((section, i) => {
    if (!isPlainObject(section) || !Array.isArray(section.elements)) return;
    const topIds = section.elements
      .filter(isPlainObject)
      .map((e) => e.id)
      .filter((id) => isNonEmptyString(id));
    if (section.readingOrder === undefined) {
      section.readingOrder = [...topIds];
      repairs.push(`sections[${i}]: created readingOrder from document order`);
      return;
    }
    if (!Array.isArray(section.readingOrder)) return; // wrong type → let validation reject
    const have = new Set(section.readingOrder);
    for (const id of topIds) {
      if (!have.has(id)) {
        section.readingOrder.push(id);
        have.add(id);
        repairs.push(`sections[${i}]: appended missing element "${id}" to readingOrder`);
      }
    }
  });

  // --- 2. missing desktop frames ---
  const desktop = isPlainObject(out.layouts) && isPlainObject(out.layouts.desktop)
    ? out.layouts.desktop
    : null; // no desktop layout at all → everything missing → let validation fail
  if (desktop) {
    const tablet = isPlainObject(out.layouts.tablet) ? out.layouts.tablet : null;
    const mobile = isPlainObject(out.layouts.mobile) ? out.layouts.mobile : null;
    out.sections.forEach((section) => {
      const ids = collectSectionElementIds(section);
      if (!ids.length) return;
      const missing = ids.filter((id) => !(id in desktop));
      if (!missing.length || missing.length > FRAME_REPAIR_CAP(ids.length)) return;
      // Stacking baseline: below the section's lowest absolutely-framed element.
      let maxBottom = 0;
      let sawAbsolute = false;
      for (const id of ids) {
        const f = desktop[id];
        if (isPlainObject(f) && f.mode === 'absolute' && typeof f.y === 'number') {
          sawAbsolute = true;
          maxBottom = Math.max(maxBottom, f.y + (typeof f.h === 'number' ? f.h : 120));
        }
      }
      for (const id of missing) {
        const inheritFrom = (tablet && isPlainObject(tablet[id])) ? 'tablet'
          : (mobile && isPlainObject(mobile[id])) ? 'mobile'
            : null;
        if (inheritFrom) {
          desktop[id] = JSON.parse(JSON.stringify(out.layouts[inheritFrom][id]));
          repairs.push(`layouts.desktop: synthesized frame for "${id}" from ${inheritFrom} frame`);
        } else if (sawAbsolute) {
          maxBottom += 24;
          desktop[id] = { mode: 'absolute', x: 0, y: maxBottom, w: 1200, h: 120, z: 0 };
          maxBottom += 120;
          repairs.push(`layouts.desktop: synthesized stacked frame for "${id}"`);
        } else {
          desktop[id] = { mode: 'flow' };
          repairs.push(`layouts.desktop: synthesized flow frame for "${id}"`);
        }
      }
    });
  }

  return repairs.length ? { doc: out, repairs } : { doc, repairs };
}

/**
 * Validate a patch (array of named operations — Decision D2).
 * Structural validation only; the patched document must separately pass
 * `validateComposition()` plus the protected-value diff check before it
 * becomes a new version.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePatch(patch) {
  const errors = [];
  if (!Array.isArray(patch) || patch.length === 0) {
    return { ok: false, errors: ['patch must be a non-empty array'] };
  }
  patch.forEach((op, i) => {
    const path = `patch[${i}]`;
    if (!isPlainObject(op)) {
      errors.push(`${path}: must be an object`);
      return;
    }
    if (!PATCH_OPS.includes(op.op)) {
      errors.push(`${path}: unknown op "${op.op}"`);
      return;
    }
    const needsElement = ['update_content', 'update_link', 'update_style', 'replace_asset', 'update_data', 'remove_element'];
    const needsSection = ['remove_section', 'replace_section'];
    if (needsElement.includes(op.op) && !isNonEmptyString(op.elementId)) {
      errors.push(`${path}: "${op.op}" requires elementId`);
    }
    if (needsSection.includes(op.op) && !isNonEmptyString(op.sectionId)) {
      errors.push(`${path}: "${op.op}" requires sectionId`);
    }
    if (op.op === 'reorder_sections' && !Array.isArray(op.order)) {
      errors.push(`${path}: "reorder_sections" requires an order array`);
    }
    if (op.op === 'insert_section' && !isPlainObject(op.section)) {
      errors.push(`${path}: "insert_section" requires a section object`);
    }
    if (op.op === 'update_style' && op.breakpoint !== undefined && !AI_BREAKPOINTS.includes(op.breakpoint)) {
      errors.push(`${path}: unknown breakpoint "${op.breakpoint}"`);
    }
    if (op.op === 'update_link' && op.changes?.link !== undefined) {
      validateLinkRef(op.changes.link, `${path}.changes.link`, errors);
    }
  });
  return { ok: errors.length === 0, errors };
}

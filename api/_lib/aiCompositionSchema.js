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
  validateProtectedValues(doc, ctx);

  return { ok: errors.length === 0, errors };
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

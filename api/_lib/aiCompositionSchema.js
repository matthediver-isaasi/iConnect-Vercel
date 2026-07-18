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

function validateAssetRef(asset, path, errors) {
  if (asset === undefined) return;
  if (!isPlainObject(asset)) {
    errors.push(`${path}: asset must be an object`);
    return;
  }
  if (!isNonEmptyString(asset.fileRepositoryId)) {
    errors.push(`${path}: asset.fileRepositoryId is required`);
  }
  if (asset.altText !== undefined && typeof asset.altText !== 'string') {
    errors.push(`${path}: asset.altText must be a string`);
  }
}

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
  validateStyle(el.style, `${path}.style`, errors);
  if ((el.type === 'image' || el.type === 'generated_illustration') && !isPlainObject(el.asset)) {
    errors.push(`${path}: ${el.type} requires an asset reference`);
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

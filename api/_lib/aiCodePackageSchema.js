// AI Design Studio V2 — structured code-package validator (Task #2904, Phase 0).
//
// V2 replaces the proprietary V1 scene-graph document (aiCompositionSchema.js,
// schemaVersion 1) with native HTML/CSS/SVG generated as a structured package.
// This module validates the RAW package shape BEFORE any sanitisation. It is
// deliberately strict about structure but does NOT inspect markup safety —
// that is the job of aiCodeHtmlSanitizer.js and aiCodeCssScope.js, which run
// next in the pipeline (aiCodePipeline.js).
//
// Contract (spec §5):
// {
//   schemaVersion: "2.0",
//   compositionType: "section" | "page_body",
//   title: string,
//   html: string,                 // semantic HTML + inline SVG, no JS
//   css: string,                  // scoped later under [data-ai-composition]
//   assets: [ { key, type, ... } ],
//   actions: [ { key, type, ...ref } ],
//   slots: [ { key, type, sourceId? } ],
//   contentManifest: [ { key, purpose? , text? } ],
//   protectedValues: [ { key, value, reason? } ],
//   responsiveTargets: { desktop, tablet, mobile },
//   promptRequirements: [string],
//   generationSummary: string
// }
//
// Pure module: no imports, node-testable.

export const AI_CODE_SCHEMA_VERSION = '2.0';

export const AI_CODE_COMPOSITION_TYPES = new Set(['section', 'page_body']);

// Action kinds mirror spec §12 (record references — never invented raw URLs
// except validated `external`).
export const AI_CODE_ACTION_TYPES = new Set([
  'internal_page', 'external_url', 'anchor', 'form', 'event',
  'event_registration', 'membership_application', 'document', 'email', 'tel',
]);

// Asset request kinds (Phase 5, Task #2909). The model requests raster
// imagery declaratively; per-field validation lives in aiCodeAssets.js
// (validateAssetRequests), called by the pipeline.
export const AI_CODE_ASSET_TYPES = new Set(['image_request']);

// Trusted iConnect slot kinds (spec §13).
export const AI_CODE_SLOT_TYPES = new Set([
  'form', 'event_registration', 'event_listing', 'membership_application',
  'document_list', 'news_listing', 'directory', 'login_prompt', 'donation',
]);

const MAX_HTML_BYTES = 400_000;
const MAX_CSS_BYTES = 200_000;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

const isStr = (v) => typeof v === 'string';
const isArr = Array.isArray;

function checkKeyedList(list, path, errors, { types = null, requireType = true } = {}) {
  if (list === undefined || list === null) return [];
  if (!isArr(list)) { errors.push(`${path} must be an array`); return []; }
  const out = [];
  const seen = new Set();
  list.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (!item || typeof item !== 'object' || isArr(item)) { errors.push(`${p} must be an object`); return; }
    const key = item.key;
    if (!isStr(key) || !KEY_RE.test(key)) { errors.push(`${p}.key must be a short identifier`); return; }
    if (seen.has(key)) { errors.push(`${p}.key "${key}" is duplicated`); return; }
    seen.add(key);
    if (requireType) {
      if (!isStr(item.type) || !item.type) { errors.push(`${p}.type is required`); return; }
      if (types && !types.has(item.type)) { errors.push(`${p}.type "${item.type}" is not supported`); return; }
    }
    out.push(item);
  });
  return out;
}

function checkResponsiveTargets(rt, errors) {
  const defaults = { desktop: 1440, tablet: 1024, mobile: 390 };
  if (rt === undefined || rt === null) return defaults;
  if (typeof rt !== 'object' || isArr(rt)) { errors.push('responsiveTargets must be an object'); return defaults; }
  const out = { ...defaults };
  for (const bp of ['desktop', 'tablet', 'mobile']) {
    if (rt[bp] === undefined) continue;
    const n = Number(rt[bp]);
    if (!Number.isFinite(n) || n < 280 || n > 3840) {
      errors.push(`responsiveTargets.${bp} must be a width in px (280–3840)`);
      continue;
    }
    out[bp] = Math.round(n);
  }
  return out;
}

/**
 * Validate a raw V2 code package.
 * Returns { ok, errors, package } — `package` is a normalised copy (only on ok).
 */
export function validateAiCodePackage(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || isArr(raw)) {
    return { ok: false, errors: ['package must be an object'], package: null };
  }
  if (raw.schemaVersion !== AI_CODE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be "${AI_CODE_SCHEMA_VERSION}"`);
  }
  const compositionType = isStr(raw.compositionType) ? raw.compositionType : 'section';
  if (!AI_CODE_COMPOSITION_TYPES.has(compositionType)) {
    errors.push(`compositionType "${raw.compositionType}" is not supported`);
  }
  const title = isStr(raw.title) ? raw.title.trim().slice(0, 200) : '';

  if (!isStr(raw.html) || !raw.html.trim()) errors.push('html is required');
  else if (Buffer.byteLength(raw.html, 'utf8') > MAX_HTML_BYTES) errors.push('html exceeds the size limit');

  if (raw.css !== undefined && raw.css !== null && !isStr(raw.css)) errors.push('css must be a string');
  const css = isStr(raw.css) ? raw.css : '';
  if (Buffer.byteLength(css, 'utf8') > MAX_CSS_BYTES) errors.push('css exceeds the size limit');

  const assets = checkKeyedList(raw.assets, 'assets', errors, { types: AI_CODE_ASSET_TYPES });
  const actions = checkKeyedList(raw.actions, 'actions', errors, { types: AI_CODE_ACTION_TYPES });
  const slots = checkKeyedList(raw.slots, 'slots', errors, { types: AI_CODE_SLOT_TYPES });
  const contentManifest = checkKeyedList(raw.contentManifest, 'contentManifest', errors, { requireType: false });
  const protectedValues = checkKeyedList(raw.protectedValues, 'protectedValues', errors, { requireType: false });
  const responsiveTargets = checkResponsiveTargets(raw.responsiveTargets, errors);

  const promptRequirements = isArr(raw.promptRequirements)
    ? raw.promptRequirements.filter(isStr).map((s) => s.slice(0, 500)).slice(0, 50)
    : [];
  const generationSummary = isStr(raw.generationSummary) ? raw.generationSummary.slice(0, 4000) : '';

  if (errors.length) return { ok: false, errors, package: null };
  return {
    ok: true,
    errors: [],
    package: {
      schemaVersion: AI_CODE_SCHEMA_VERSION,
      compositionType,
      title,
      html: raw.html,
      css,
      assets,
      actions,
      slots,
      contentManifest,
      protectedValues,
      responsiveTargets,
      promptRequirements,
      generationSummary,
    },
  };
}

/**
 * Cross-check manifests against the (sanitised) HTML:
 *   - every data-ai-action key in the HTML must exist in `actions`
 *   - every data-iconnect-slot placeholder must have a matching slot manifest
 *   - meaningful stable data-ai-id coverage (at least one)
 * `htmlRefs` comes from the sanitiser report ({ actionKeys, slotKeys, aiIds }).
 */
export function crossCheckManifests(pkg, htmlRefs) {
  const errors = [];
  const actionKeys = new Set((pkg.actions || []).map((a) => a.key));
  const slotKeys = new Set((pkg.slots || []).map((s) => s.key));
  for (const k of htmlRefs.actionKeys || []) {
    if (!actionKeys.has(k)) errors.push(`HTML references action "${k}" missing from the actions manifest — every data-ai-action attribute value must be YOUR OWN kebab-case key with a matching actions[].key entry; an action TYPE name (e.g. "anchor") is not a key`);
  }
  for (const k of htmlRefs.slotKeys || []) {
    if (!slotKeys.has(k)) errors.push(`HTML references slot "${k}" missing from the slots manifest`);
  }
  const assetKeys = new Set((pkg.assets || []).map((a) => a.key));
  for (const k of htmlRefs.assetKeys || []) {
    if (!assetKeys.has(k)) errors.push(`HTML references image asset "${k}" missing from the assets manifest`);
  }
  if (!(htmlRefs.aiIds || []).length) {
    errors.push('HTML contains no stable data-ai-id identifiers');
  }
  const dupes = new Set();
  const seen = new Set();
  for (const id of htmlRefs.aiIds || []) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  for (const id of dupes) errors.push(`data-ai-id "${id}" is duplicated in the HTML`);
  return { ok: errors.length === 0, errors };
}

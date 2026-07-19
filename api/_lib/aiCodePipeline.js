// AI Design Studio V2 — Phase 0 safety pipeline (Task #2904).
//
// One choke point that takes a RAW V2 code package and produces the sanitised,
// scoped package that gets persisted as an immutable ai_composition_version
// document (renderer_version 2). Order (spec §10 stage 4):
//
//   1. validateAiCodePackage      — strict structural schema ("2.0")
//   2. sanitizeAiCodeHtml         — jsdom+DOMPurify HTML & inline-SVG cleanse
//   3. crossCheckManifests        — data-ai-action / data-iconnect-slot / ids
//   4. scopeAiCodeCss             — PostCSS AST scoping under the wrapper
//   5. assertAllSelectorsScoped   — belt-and-braces leak check on the OUTPUT
//
// The pipeline NEVER repairs silently: everything removed or rejected is
// returned in `report` so the Composition Inspector can show sanitiser and
// scoping changes, and hard failures return ok:false with explicit errors.

import { validateAiCodePackage, crossCheckManifests } from './aiCodePackageSchema.js';
import { validateAssetRequests } from './aiCodeAssets.js';
import { sanitizeAiCodeHtml } from './aiCodeHtmlSanitizer.js';
import { scopeAiCodeCss, assertAllSelectorsScoped, formatCssRejection } from './aiCodeCssScope.js';

/**
 * Run the full Phase 0 pipeline.
 *
 * @param rawPackage  the model/hand-authored V2 package (schemaVersion "2.0")
 * @param compositionId  the REAL composition uuid — the scope wrapper value.
 *   The model never controls this; any scope it embedded is stripped.
 * @param options.allowedImageHosts  URL prefixes <img src> may use.
 *
 * Returns { ok, errors, document, report }:
 *   document — persistable sanitised package:
 *     { ...validated pkg, html: <clean>, css: <scoped>, compositionId }
 *   report   — { htmlRemoved, cssRejections, aiIds, actionKeys, slotKeys,
 *                contentKeys, headings }
 */
export function runAiCodePipeline(rawPackage, compositionId, { allowedImageHosts = [] } = {}) {
  const fail = (errors, report = null) => ({ ok: false, errors, document: null, report });

  if (!compositionId || typeof compositionId !== 'string') {
    return fail(['compositionId is required']);
  }

  // 1. Schema.
  const v = validateAiCodePackage(rawPackage);
  if (!v.ok) return fail(v.errors);
  const pkg = v.package;

  // 1b. Asset requests (Phase 5): image_request entries must carry a subject
  // and alt text; the fulfilment stage relies on these being well-formed.
  const av = validateAssetRequests(pkg.assets);
  if (!av.ok) return fail(av.errors);
  pkg.assets = av.assets;

  // 2. HTML + SVG sanitisation.
  let html, htmlReport;
  try {
    ({ html, report: htmlReport } = sanitizeAiCodeHtml(pkg.html, { allowedImageHosts }));
  } catch (err) {
    return fail([`HTML failed to parse: ${err.message}`]);
  }
  if (!String(html || '').trim()) return fail(['HTML is empty after sanitisation']);

  // 3. Manifest cross-checks against the CLEAN html.
  const xc = crossCheckManifests(pkg, htmlReport);
  if (!xc.ok) return fail(xc.errors, { htmlRemoved: htmlReport.removed });

  // 4. CSS AST scoping.
  const scoped = scopeAiCodeCss(pkg.css, compositionId);
  if (!scoped.ok) {
    return fail(scoped.rejections.map(formatCssRejection),
      { htmlRemoved: htmlReport.removed });
  }

  // 4b. Policy: reject-don't-repair. The scoper drops offending rules so it
  // can report ALL violations in one pass, but the pipeline hard-fails the
  // whole package on any non-warning rejection — a stored document is never
  // a silently repaired version of what the generator produced.
  const hardCss = scoped.rejections.filter((r) => !r.warning);
  if (hardCss.length) {
    return fail(hardCss.map(formatCssRejection),
      { htmlRemoved: htmlReport.removed, cssRejections: scoped.rejections });
  }

  // 5. Output leak check — the wrapper prefix must hold for EVERY selector.
  const leak = assertAllSelectorsScoped(scoped.css, compositionId);
  if (!leak.ok) {
    return fail(leak.offenders.map((s) => `CSS selector escaped the wrapper: ${s}`),
      { htmlRemoved: htmlReport.removed, cssRejections: scoped.rejections });
  }

  const report = {
    htmlRemoved: htmlReport.removed,
    cssRejections: scoped.rejections,
    aiIds: htmlReport.aiIds,
    actionKeys: htmlReport.actionKeys,
    slotKeys: htmlReport.slotKeys,
    contentKeys: htmlReport.contentKeys,
    assetKeys: htmlReport.assetKeys,
    headings: htmlReport.headings,
  };

  return {
    ok: true,
    errors: [],
    document: {
      schemaVersion: pkg.schemaVersion,
      rendererVersion: 2,
      compositionType: pkg.compositionType,
      title: pkg.title,
      compositionId,
      html,
      css: scoped.css,
      assets: pkg.assets,
      actions: pkg.actions,
      slots: pkg.slots,
      contentManifest: pkg.contentManifest,
      protectedValues: pkg.protectedValues,
      responsiveTargets: pkg.responsiveTargets,
      promptRequirements: pkg.promptRequirements,
      generationSummary: pkg.generationSummary,
      sanitisation: report,
    },
    report,
  };
}

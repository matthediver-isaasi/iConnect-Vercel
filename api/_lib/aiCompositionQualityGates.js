/**
 * AI Composition quality gates — Task #2894.
 *
 * Four deterministic gates that reject structurally valid but visually
 * broken or semantically empty compositions BEFORE the author ever sees
 * them. Failures are fed back into the existing document retry loop
 * (aiCompositionPipeline.runDocumentAttempt) as validation errors.
 *
 *   1. Plan contract   — the plan stage declares its visual requirements
 *                        (requiresIllustration / requiresCardRecipe /
 *                        requiresResponsiveRecomposition, focal point,
 *                        desktop structure, mobile transformation); the
 *                        final document is checked against them.
 *   2. Prompt fulfilment — mandatory requirements derived from the brief
 *                        (visual asset where requested, real CTA action,
 *                        non-trivial desktop composition, a mobile
 *                        transformation, adequate section height).
 *   3. Layout inspection — deterministic geometry over the effective
 *                        per-breakpoint frames (zero-size, severe pairwise
 *                        text overlap incl. all-text-at-one-origin,
 *                        off-canvas, clipping, empty containers, blank
 *                        compositions, implausible text density).
 *   4. CSS validation  — the generated scoped stylesheet is parsed with
 *                        postcss (a real CSS parser) and rejected for
 *                        invalid values, missing units, unsafe properties,
 *                        unscoped selectors, external URLs, absolute
 *                        positioning without complete geometry, negative
 *                        dimensions, unsupported functions and
 *                        NaN/infinite values.
 *
 * Pure module: no DB, no network. The screenshot review gate (browserless +
 * vision) lives in aiCompositionScreenshotGate.js.
 */

import postcss from 'postcss';
import { frameFor, buildAicCss } from '../../client/src/lib/aiCompositionRender.js';

export const GATE_BREAKPOINT_WIDTHS = { desktop: 1200, tablet: 768, mobile: 375 };

const TEXT_TYPES = new Set(['heading', 'paragraph', 'button', 'text_link', 'statistic', 'label', 'caption']);
const VISUAL_ASSET_TYPES = new Set(['image', 'generated_illustration']);
const INFOGRAPHIC_TYPES = new Set([
  'timeline_item', 'process_step', 'comparison_item', 'simple_chart', 'structured_infographic',
]);
const CONTAINER_TYPES = new Set(['container', 'group', 'card', 'overlay', 'structured_infographic']);

// ---------------------------------------------------------------------------
// Shared walking / text helpers
// ---------------------------------------------------------------------------

function walk(doc, fn) {
  for (const section of doc?.sections || []) {
    const visit = (els, parents) => {
      for (const el of els || []) {
        if (!el || typeof el !== 'object' || !el.id) continue;
        fn(el, section, parents);
        if (Array.isArray(el.children)) visit(el.children, [...parents, el]);
      }
    };
    visit(section.elements, []);
  }
}

export function textOf(el) {
  const c = el?.content || {};
  const bits = [c.text, c.label, c.value, c.heading];
  if (typeof c.html === 'string') bits.push(c.html.replace(/<[^>]+>/g, ' '));
  return bits.filter((b) => typeof b === 'string').join(' ').replace(/\s+/g, ' ').trim();
}

function isVisible(doc, el, bp) {
  const f = frameFor(doc, el.id, bp);
  return !f || f.visible !== false;
}

function issue(gate, code, message, extra = {}) {
  return { gate, code, message, ...extra };
}

// ---------------------------------------------------------------------------
// Gate 1: creative-plan contract
// ---------------------------------------------------------------------------

const CONTRACT_TEXT_FIELDS = [
  'intendedComposition', 'focalPoint', 'desktopStructure',
  'mobileTransformation', 'referenceApplication',
];

/** Normalize the plan's declared visual contract (whitelisted fields only). */
export function sanitizePlanContract(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const out = {
    requiresIllustration: raw.requiresIllustration === true,
    requiresCardRecipe: raw.requiresCardRecipe === true,
    requiresResponsiveRecomposition: raw.requiresResponsiveRecomposition !== false,
  };
  for (const f of CONTRACT_TEXT_FIELDS) {
    const v = clean(raw[f], 400);
    if (v) out[f] = v;
  }
  const assets = Array.isArray(raw.requiredAssets) ? raw.requiredAssets : [];
  out.requiredAssets = assets
    .filter((a) => typeof a === 'string' && a.trim())
    .slice(0, 10)
    .map((a) => clean(a, 160));
  const fams = Array.isArray(raw.componentFamilies) ? raw.componentFamilies : [];
  out.componentFamilies = fams
    .filter((a) => typeof a === 'string' && a.trim())
    .slice(0, 10)
    .map((a) => clean(a, 80));
  return out;
}

function docStats(doc) {
  const stats = {
    total: 0,
    types: new Set(),
    visualAssets: 0,
    infographic: 0,
    cards: 0,
    textEls: 0,
    ctas: [],
  };
  walk(doc, (el) => {
    stats.total += 1;
    stats.types.add(el.type);
    if (VISUAL_ASSET_TYPES.has(el.type)) stats.visualAssets += 1;
    if (INFOGRAPHIC_TYPES.has(el.type)) stats.infographic += 1;
    if (el.type === 'card') stats.cards += 1;
    if (TEXT_TYPES.has(el.type) && textOf(el)) stats.textEls += 1;
    if ((el.type === 'button' || el.type === 'text_link') && hasRealAction(el)) stats.ctas.push(el.id);
  });
  return stats;
}

/** A CTA is "real" when its link carries a usable destination. */
export function hasRealAction(el) {
  const l = el?.link;
  if (typeof el?.resolvedHref === 'string' && el.resolvedHref.trim()) return true;
  if (!l || typeof l !== 'object' || !l.kind) return false;
  return Boolean(
    l.url || l.pageId || l.eventId || l.formId || l.fileId || l.tierId
    || l.anchorId || l.actionKey || l.address || l.number
    || l.kind === 'membership_application',
  );
}

/** True when mobile meaningfully re-composes rather than duplicating desktop. */
export function hasMobileRecomposition(doc) {
  const mobile = doc?.layouts?.mobile || {};
  for (const [id, ov] of Object.entries(mobile)) {
    if (!ov || typeof ov !== 'object') continue;
    const desktop = doc?.layouts?.desktop?.[id] || {};
    for (const key of ['mode', 'x', 'y', 'w', 'h', 'visible']) {
      if (ov[key] !== undefined && ov[key] !== desktop[key]) return true;
    }
    const dCols = desktop.grid?.columns;
    const mCols = ov.grid?.columns;
    if (mCols !== undefined && mCols !== dCols) return true;
    if (ov.flex && JSON.stringify(ov.flex) !== JSON.stringify(desktop.flex || null)) return true;
  }
  return false;
}

/** Check the final document against the plan's declared contract. */
export function checkPlanContract(doc, plan) {
  const issues = [];
  const contract = plan?.contract;
  if (!contract) return issues; // legacy plans without a contract: nothing to enforce
  const stats = docStats(doc);
  if (contract.requiresIllustration && stats.visualAssets === 0 && stats.infographic === 0) {
    issues.push(issue('plan_contract', 'missing_illustration',
      'The plan promised illustration/imagery but the document contains no image, illustration or infographic element.'));
  }
  if (contract.requiresCardRecipe && stats.cards === 0) {
    issues.push(issue('plan_contract', 'missing_card_recipe',
      'The plan promised a card-based component recipe but the document contains no card elements.'));
  }
  if (contract.requiresResponsiveRecomposition && !hasMobileRecomposition(doc)) {
    issues.push(issue('plan_contract', 'missing_mobile_recomposition',
      'The plan promised a mobile transformation but the mobile layout is identical to desktop (no mobile overrides).'));
  }
  const planned = Array.isArray(plan?.sections) ? plan.sections.length : 0;
  const actual = Array.isArray(doc?.sections) ? doc.sections.length : 0;
  if (planned > 0 && actual !== planned) {
    issues.push(issue('plan_contract', 'section_count_mismatch',
      `The plan declared ${planned} section(s) but the document has ${actual}.`));
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Gate 2: prompt fulfilment
// ---------------------------------------------------------------------------

const VISUAL_REQUEST_RE = /\b(image|images|photo|photos|picture|illustration|illustrated|visual|visuals|infographic|chart|graph|diagram|timeline|icons?|graphics?)\b/i;

/**
 * Derive the mandatory requirements for this generation. Recorded alongside
 * the gate report so a rejection is always explainable.
 */
export function derivePromptRequirements({ brief = '', options = {}, plan = null } = {}) {
  const contract = plan?.contract || {};
  const text = [brief, options.contentNotes, options.direction, options.purpose]
    .filter(Boolean).join(' ');
  return {
    visualAsset: VISUAL_REQUEST_RE.test(text) || contract.requiresIllustration === true,
    referenceRecipe: Boolean(options.styleReference),
    realCta: true,
    nonTrivialDesktop: true,
    mobileTransformation: contract.requiresResponsiveRecomposition !== false,
    adequateSectionHeight: true,
  };
}

const MIN_ELEMENTS = 4;
const MIN_DISTINCT_TYPES = 3;
const MIN_SECTION_HEIGHT = 120; // px — an absolute-composed section shorter than this is a sliver

function sectionAbsoluteExtent(doc, section, bp) {
  let hasAbsolute = false;
  let maxBottom = 0;
  const visit = (els) => {
    for (const el of els || []) {
      if (!el?.id) continue;
      const f = frameFor(doc, el.id, bp);
      if (f && f.mode === 'absolute' && f.visible !== false) {
        hasAbsolute = true;
        const y = Number(f.y) || 0;
        const h = Number(f.h) || 0;
        maxBottom = Math.max(maxBottom, y + h);
      }
      if (Array.isArray(el.children)) visit(el.children);
    }
  };
  visit(section.elements);
  return { hasAbsolute, maxBottom };
}

/** Enforce the derived requirements against the final document. */
export function checkPromptFulfilment(doc, requirements) {
  const issues = [];
  const req = requirements || {};
  const stats = docStats(doc);

  if (req.visualAsset && stats.visualAssets === 0 && stats.infographic === 0) {
    issues.push(issue('prompt_fulfilment', 'missing_visual_asset',
      'The brief asked for imagery/visuals but the document contains no image, illustration or intentional infographic structure.'));
  }
  if (req.realCta && stats.ctas.length === 0) {
    issues.push(issue('prompt_fulfilment', 'missing_real_cta',
      'The document has no call-to-action with a real destination (a button or link whose link resolves to a page, record, URL, email or anchor).'));
  }
  if (req.nonTrivialDesktop && (stats.total < MIN_ELEMENTS || stats.types.size < MIN_DISTINCT_TYPES)) {
    issues.push(issue('prompt_fulfilment', 'trivial_composition',
      `The desktop composition is too thin (${stats.total} element(s) across ${stats.types.size} type(s)); a real composition needs at least ${MIN_ELEMENTS} elements of ${MIN_DISTINCT_TYPES}+ types.`));
  }
  if (req.mobileTransformation && !hasMobileRecomposition(doc)) {
    issues.push(issue('prompt_fulfilment', 'no_mobile_transformation',
      'The mobile layout is identical to desktop — declare at least one mobile layout override that re-composes the content for small screens.'));
  }
  if (req.adequateSectionHeight) {
    for (const section of doc?.sections || []) {
      const { hasAbsolute, maxBottom } = sectionAbsoluteExtent(doc, section, 'desktop');
      if (hasAbsolute && maxBottom < MIN_SECTION_HEIGHT) {
        issues.push(issue('prompt_fulfilment', 'inadequate_section_height',
          `Section "${section.id}" composes absolutely but its content only reaches ${Math.round(maxBottom)}px — the section would render as an empty sliver.`,
          { sectionId: section.id }));
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Gate 3: deterministic layout inspection
// ---------------------------------------------------------------------------

const OVERLAP_RATIO = 0.6; // of the smaller rect
const ORIGIN_CLUSTER_MIN = 3; // text elements sharing one origin = the bnms failure
const PX2_PER_CHAR = 20; // implausible below this (≈ half a 16px glyph cell)

function estimateRect(frame, canvasWidth) {
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    x: num(frame.x, 0),
    y: num(frame.y, 0),
    w: num(frame.w, Math.min(300, canvasWidth)),
    h: num(frame.h, 40),
  };
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Inspect the effective geometry of every visible element at every
 * breakpoint. Deterministic and DOM-free: the frames model IS the geometry
 * the renderer paints (absolute frames map 1:1 to left/top/width/height).
 */
export function inspectLayout(doc) {
  const issues = [];
  const push = (code, message, extra) => issues.push(issue('layout', code, message, extra));

  // --- blank composition / blank sections (breakpoint-independent content) --
  let anyContent = false;
  for (const section of doc?.sections || []) {
    let sectionContent = false;
    const visit = (els) => {
      for (const el of els || []) {
        if (!el?.id) continue;
        if ((TEXT_TYPES.has(el.type) && textOf(el))
          || VISUAL_ASSET_TYPES.has(el.type)
          || INFOGRAPHIC_TYPES.has(el.type)
          || el.type === 'canvas_component_placeholder') {
          sectionContent = true;
        }
        if (Array.isArray(el.children)) visit(el.children);
      }
    };
    visit(section.elements);
    if (!sectionContent) {
      push('blank_section', `Section "${section.id}" contains no visible text, imagery or components.`, { sectionId: section.id });
    }
    anyContent = anyContent || sectionContent;
  }
  if (!anyContent) {
    push('blank_composition', 'The composition contains no visible content at all.');
  }

  // --- empty containers ----------------------------------------------------
  walk(doc, (el, section) => {
    if (!CONTAINER_TYPES.has(el.type)) return;
    if (el.type === 'structured_infographic') return; // may carry own content model
    if (!Array.isArray(el.children) || el.children.length === 0) {
      push('empty_container', `${el.type} "${el.id}" has no children — an empty box would render.`, { elementId: el.id, sectionId: section.id });
    }
  });

  // --- per-breakpoint geometry ----------------------------------------------
  for (const [bp, width] of Object.entries(GATE_BREAKPOINT_WIDTHS)) {
    const textRects = []; // { el, section, rect }
    walk(doc, (el, section, parents) => {
      const f = frameFor(doc, el.id, bp);
      if (!f || f.visible === false) return;
      if (f.mode !== 'absolute') return; // flow/flex/grid cannot stack at an origin
      // Geometry is only judged where it was AUTHORED: desktop always, and
      // tablet/mobile only when the element carries an override there.
      // Inherited desktop frames on narrower canvases are an expected,
      // renderer-handled condition — not a generation defect.
      const authoredHere = bp === 'desktop' || Boolean(doc?.layouts?.[bp]?.[el.id]);
      if (!authoredHere) return;

      // Zero/negative size (explicitly declared).
      if ((typeof f.w === 'number' && f.w <= 0) || (typeof f.h === 'number' && f.h <= 0)) {
        push('zero_size', `Element "${el.id}" has a zero or negative size at ${bp}.`, { elementId: el.id, sectionId: section.id, breakpoint: bp });
      }

      const rect = estimateRect(f, width);

      // Off-canvas.
      if (rect.x + rect.w <= 0 || rect.x >= width || rect.y + rect.h <= -1 || rect.y < -200) {
        push('off_canvas', `Element "${el.id}" sits entirely off the ${bp} canvas (x=${rect.x}, y=${rect.y}).`, { elementId: el.id, sectionId: section.id, breakpoint: bp });
      } else if (rect.x + rect.w > width + 40) {
        push('off_canvas', `Element "${el.id}" extends ${Math.round(rect.x + rect.w - width)}px past the ${bp} canvas width.`, { elementId: el.id, sectionId: section.id, breakpoint: bp });
      }

      // Clipped by an absolutely-sized ancestor.
      for (const p of parents) {
        const pf = frameFor(doc, p.id, bp);
        if (!pf || pf.mode !== 'absolute') continue;
        const pw = typeof pf.w === 'number' ? pf.w : null;
        const ph = typeof pf.h === 'number' ? pf.h : null;
        if ((pw !== null && rect.x + rect.w > pw + 40) || (ph !== null && rect.y + rect.h > ph + 40)) {
          push('clipped', `Element "${el.id}" overflows its container "${p.id}" and would be clipped at ${bp}.`, { elementId: el.id, sectionId: section.id, breakpoint: bp });
          break;
        }
      }

      // Text density: text that cannot plausibly fit its declared box.
      if (TEXT_TYPES.has(el.type)) {
        const chars = textOf(el).length;
        if (chars > 0) {
          if (typeof f.w === 'number' && typeof f.h === 'number' && f.w > 0 && f.h > 0) {
            const area = f.w * f.h;
            if (area < chars * PX2_PER_CHAR) {
              push('text_density', `Element "${el.id}" declares a ${f.w}×${f.h}px box for ${chars} characters of text at ${bp} — the text cannot fit.`, { elementId: el.id, sectionId: section.id, breakpoint: bp });
            }
          }
          textRects.push({ el, section, rect });
        }
      }
    });

    // Severe pairwise text overlap (the bnms failure: everything at one origin).
    const originClusters = new Map();
    for (const t of textRects) {
      const key = `${t.rect.x},${t.rect.y}`;
      originClusters.set(key, (originClusters.get(key) || 0) + 1);
    }
    for (const [key, count] of originClusters) {
      if (count >= ORIGIN_CLUSTER_MIN) {
        push('stacked_at_origin', `${count} text elements share the same position (${key}) at ${bp} — the text renders as an unreadable stack.`, { breakpoint: bp });
      }
    }
    for (let i = 0; i < textRects.length; i += 1) {
      for (let j = i + 1; j < textRects.length; j += 1) {
        const a = textRects[i];
        const b = textRects[j];
        const area = overlapArea(a.rect, b.rect);
        if (area <= 0) continue;
        const minArea = Math.min(a.rect.w * a.rect.h, b.rect.w * b.rect.h);
        if (minArea > 0 && area / minArea > OVERLAP_RATIO) {
          push('text_overlap', `Text elements "${a.el.id}" and "${b.el.id}" overlap severely at ${bp}.`, { elementId: a.el.id, sectionId: a.section.id, breakpoint: bp });
        }
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Gate 4: CSS validation (real parser — postcss)
// ---------------------------------------------------------------------------

const LENGTH_PROPS = new Set([
  'width', 'height', 'left', 'top', 'right', 'bottom', 'min-height', 'min-width',
  'max-width', 'max-height', 'font-size', 'gap', 'letter-spacing', 'border-radius',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
]);
const NON_NEGATIVE_PROPS = new Set([
  'width', 'height', 'min-height', 'min-width', 'max-width', 'max-height',
  'font-size', 'gap', 'padding', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left', 'border-radius', 'opacity',
]);
const UNSAFE_PROPS = new Set(['behavior', '-moz-binding', 'content', 'src']);
const ALLOWED_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'linear-gradient', 'radial-gradient', 'conic-gradient',
  'calc', 'minmax', 'repeat', 'rotate', 'rotatez', 'translate', 'translatex',
  'translatey', 'scale', 'scalex', 'scaley', 'blur', 'brightness', 'contrast',
  'grayscale', 'drop-shadow', 'polygon', 'inset', 'circle', 'ellipse',
]);
const SCOPE_RE = /\[data-aic=/;
const NAN_RE = /\b(nan|infinity|-infinity|undefined|null)\b/i;
const BARE_NUMBER_RE = /^-?\d+(\.\d+)?$/;
const UNITLESS_OK = new Set(['z-index', 'opacity', 'line-height', 'font-weight', 'flex', 'order', 'aspect-ratio', 'grid-template-columns']);

/**
 * Parse and validate the generated scoped stylesheet. Returns
 * { ok, errors: [{selector?, prop?, value?, message}] } — every invalid
 * declaration is recorded so generation diagnostics stay explainable.
 */
export function validateAicStylesheet(css) {
  const errors = [];
  let root;
  try {
    root = postcss.parse(String(css || ''));
  } catch (err) {
    return { ok: false, errors: [{ message: `Stylesheet failed to parse: ${err.message}` }] };
  }

  root.walkAtRules((at) => {
    if (at.name !== 'media') {
      errors.push({ message: `Unsupported at-rule @${at.name}.` });
    }
  });

  root.walkRules((rule) => {
    const selector = rule.selector || '';
    if (!SCOPE_RE.test(selector)) {
      errors.push({ selector, message: 'Selector is not scoped to the composition instance ([data-aic=…]).' });
    }
    // Absolute positioning must carry complete geometry within the same rule
    // (inset:0 counts — the background wash pattern).
    const decls = {};
    rule.walkDecls((d) => { decls[d.prop.toLowerCase()] = String(d.value); });
    if (String(decls.position || '').toLowerCase() === 'absolute') {
      const hasInset = decls.inset !== undefined;
      const complete = hasInset || (decls.left !== undefined && decls.top !== undefined && decls.width !== undefined);
      if (!complete) {
        errors.push({ selector, message: 'position:absolute without complete geometry (needs left+top+width, or inset).' });
      }
    }
  });

  root.walkDecls((decl) => {
    const prop = decl.prop.toLowerCase();
    const value = String(decl.value);
    const v = value.toLowerCase();
    const selector = decl.parent?.selector || '';
    const record = (message) => errors.push({ selector, prop, value, message });

    if (UNSAFE_PROPS.has(prop)) record(`Unsafe property "${prop}".`);
    if (NAN_RE.test(v)) record('Value contains NaN/Infinity/undefined.');
    if (/url\s*\(/i.test(v)) record('External URL values are not allowed in the stylesheet.');
    if (/expression\s*\(|javascript:|@import/i.test(v)) record('Unsafe value.');

    // Unsupported functions.
    for (const m of v.matchAll(/([a-z-]+)\s*\(/gi)) {
      const fn = m[1].toLowerCase();
      if (fn === 'url' || fn === 'expression') continue; // already recorded above
      if (!ALLOWED_FUNCTIONS.has(fn)) record(`Unsupported CSS function "${fn}()".`);
    }

    // Missing units on length properties.
    if (LENGTH_PROPS.has(prop) && !UNITLESS_OK.has(prop)) {
      for (const part of value.split(/\s+/)) {
        if (BARE_NUMBER_RE.test(part) && Number(part) !== 0) {
          record(`Missing unit on length value "${part}".`);
          break;
        }
      }
    }

    // Negative dimensions.
    if (NON_NEGATIVE_PROPS.has(prop)) {
      const n = parseFloat(value);
      if (Number.isFinite(n) && n < 0) record(`Negative value ${value} on "${prop}".`);
    }
  });

  return { ok: errors.length === 0, errors: errors.slice(0, 50) };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export const QUALITY_GATES = ['plan_contract', 'prompt_fulfilment', 'layout', 'css'];

/**
 * Run all deterministic quality gates over a schema-valid document.
 * Returns { ok, failures: string[] (retry feedback), report }.
 */
export function runQualityGates({ doc, plan = null, brief = '', options = {} }) {
  const requirements = derivePromptRequirements({ brief, options, plan });
  const planIssues = checkPlanContract(doc, plan);
  const promptIssues = checkPromptFulfilment(doc, requirements);
  const layoutIssues = inspectLayout(doc);
  let cssResult;
  try {
    cssResult = validateAicStylesheet(buildAicCss(doc, 'gate'));
  } catch (err) {
    cssResult = { ok: false, errors: [{ message: `Stylesheet could not be generated: ${err.message}` }] };
  }
  const cssIssues = cssResult.errors.map((e) => issue('css', 'invalid_declaration',
    `${e.message}${e.prop ? ` (${e.prop}: ${e.value})` : ''}${e.selector ? ` in ${String(e.selector).slice(0, 80)}` : ''}`));

  const all = [...planIssues, ...promptIssues, ...layoutIssues, ...cssIssues];
  return {
    ok: all.length === 0,
    failures: all.map((i) => `[${i.gate}] ${i.message}`),
    report: {
      requirements,
      gates: {
        plan_contract: { ok: planIssues.length === 0, issues: planIssues },
        prompt_fulfilment: { ok: promptIssues.length === 0, issues: promptIssues },
        layout: { ok: layoutIssues.length === 0, issues: layoutIssues },
        css: { ok: cssIssues.length === 0, issues: cssIssues },
      },
      checkedAt: new Date().toISOString(),
    },
  };
}

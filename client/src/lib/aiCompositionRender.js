// AI Composition renderer helpers — Task #2849.
//
// React-free (node-testable) logic for rendering a validated AI Composition
// document in-DOM:
//   - buildAicCss(doc, instanceId): instance-scoped stylesheet. EVERY selector
//     is prefixed with `[data-aic="<instanceId>"]` so generated styles can
//     never leak outside the composition. Tablet/mobile emit BOTH real
//     @media rules (public rendering) AND `[data-aic-bp="…"]` attribute
//     variants (forced-breakpoint editor preview, where the viewport doesn't
//     actually change).
//   - sanitizeAicStyle / sanitizeAicHtml: defence-in-depth re-checks at render
//     time (the validator already gates persistence — see aiCompositionSchema).
//   - orderedElements(section): DOM order follows readingOrder.
//
// The document model mirrors api/_lib/aiCompositionSchema.js (schemaVersion 1).

export const AIC_BREAKPOINT_WIDTHS = { desktop: 1200, tablet: 820, mobile: 390 };
const TABLET_MAX = 1024;
const MOBILE_MAX = 640;

// Mirror of the server allowlist (client bundle must not import api/**).
export const AIC_CSS_ALLOWLIST = new Set([
  'color', 'backgroundColor', 'backgroundImage',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
  'letterSpacing', 'textAlign', 'textTransform', 'textDecoration',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
  'borderRadius', 'boxShadow', 'outline',
  'gap', 'alignItems', 'justifyContent', 'flexDirection', 'flexWrap',
  'gridTemplateColumns', 'aspectRatio',
  'opacity', 'overflow', 'clipPath', 'filter', 'mixBlendMode',
  'transform', 'objectFit', 'objectPosition',
]);

const UNSAFE_CSS_VALUE_RE = /url\s*\(|expression\s*\(|@import|javascript:|!important|var\s*\(|[{};]|<\//i;
const GRADIENT_ONLY_RE = /^(linear|radial|conic)-gradient\(/i;
const TRANSFORM_SAFE_RE = /^(\s*(rotate|rotateZ|translate|translateX|translateY|scale|scaleX|scaleY)\([^()]*\)\s*)+$/i;

/** Drop any non-allowlisted or unsafe style entries. Returns a clean object. */
export function sanitizeAicStyle(style) {
  const out = {};
  if (!style || typeof style !== 'object') return out;
  for (const [key, value] of Object.entries(style)) {
    if (!AIC_CSS_ALLOWLIST.has(key)) continue;
    const str = String(value ?? '').trim();
    if (!str) continue;
    if (UNSAFE_CSS_VALUE_RE.test(str)) continue;
    if (key === 'backgroundImage' && !GRADIENT_ONLY_RE.test(str)) continue;
    if (key === 'transform' && !TRANSFORM_SAFE_RE.test(str)) continue;
    out[key] = str;
  }
  return out;
}

// content.html may only carry a small inline-formatting tag set. Everything
// else is stripped (tags removed, text kept). Attributes are always dropped.
const HTML_TAG_ALLOWLIST = new Set(['p', 'strong', 'em', 'ul', 'ol', 'li', 'br', 'span', 'b', 'i']);

export function sanitizeAicHtml(html) {
  const s = String(html || '');
  return s.replace(/<\/?\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, tag) => {
    const t = tag.toLowerCase();
    if (!HTML_TAG_ALLOWLIST.has(t)) return '';
    const close = /^<\s*\//.test(m);
    return close ? `</${t}>` : (t === 'br' ? '<br/>' : `<${t}>`);
  });
}

const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function styleDecls(style) {
  return Object.entries(sanitizeAicStyle(style))
    .map(([k, v]) => `${kebab(k)}:${v};`)
    .join('');
}

// CSS-escape an id used inside an attribute selector / class name.
function cssSafe(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

/** Top-level elements of a section in readingOrder (DOM order = reading order). */
export function orderedElements(section) {
  const els = Array.isArray(section?.elements) ? section.elements.filter((e) => e && e.id) : [];
  const ro = Array.isArray(section?.readingOrder) ? section.readingOrder : [];
  const byId = new Map(els.map((e) => [e.id, e]));
  const out = [];
  for (const id of ro) {
    if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); }
  }
  for (const e of byId.values()) out.push(e); // any stragglers keep source order
  return out;
}

function mergeFrame(base, override) {
  if (!override) return base || null;
  return { ...(base || {}), ...Object.fromEntries(Object.entries(override).filter(([, v]) => v !== undefined)) };
}

/** Effective frame for an element at a breakpoint (tablet/mobile inherit desktop). */
export function frameFor(doc, elementId, bp) {
  const desktop = doc?.layouts?.desktop?.[elementId] || null;
  if (bp === 'desktop') return desktop;
  const tablet = mergeFrame(desktop, doc?.layouts?.tablet?.[elementId]);
  if (bp === 'tablet') return tablet;
  return mergeFrame(tablet, doc?.layouts?.mobile?.[elementId]);
}

function frameDecls(frame, containerMode) {
  if (!frame) return '';
  const d = [];
  if (frame.visible === false) { return 'display:none;'; }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (frame.mode === 'absolute') {
    d.push('position:absolute;');
    if (num(frame.x) !== null) d.push(`left:${frame.x}px;`);
    if (num(frame.y) !== null) d.push(`top:${frame.y}px;`);
    if (num(frame.w) !== null) d.push(`width:${frame.w}px;`);
    if (num(frame.h) !== null) d.push(`height:${frame.h}px;`);
    if (num(frame.z) !== null) d.push(`z-index:${frame.z};`);
  } else {
    if (num(frame.w) !== null) d.push(`max-width:${frame.w}px;`);
    if (num(frame.h) !== null) d.push(`min-height:${frame.h}px;`);
  }
  if (num(frame.minH) !== null) d.push(`min-height:${frame.minH}px;`);
  if (num(frame.maxW) !== null) d.push(`max-width:${frame.maxW}px;`);
  if (frame.mode === 'flex') {
    d.push('display:flex;');
    const f = frame.flex || {};
    if (f.direction) d.push(`flex-direction:${cssSafe(f.direction) === 'row' ? 'row' : 'column'};`);
    if (typeof f.gap === 'number') d.push(`gap:${f.gap}px;`);
    if (f.align === 'center' || f.align === 'start' || f.align === 'end' || f.align === 'stretch') {
      d.push(`align-items:${f.align === 'start' ? 'flex-start' : f.align === 'end' ? 'flex-end' : f.align};`);
    }
  }
  if (frame.mode === 'grid') {
    d.push('display:grid;');
    const g = frame.grid || {};
    const cols = Number(g.columns);
    if (Number.isFinite(cols) && cols >= 1 && cols <= 12) {
      d.push(`grid-template-columns:repeat(${Math.round(cols)},minmax(0,1fr));`);
    }
    if (typeof g.gap === 'number') d.push(`gap:${g.gap}px;`);
  }
  if (containerMode === 'absolute' && frame.mode !== 'absolute') {
    // element flows inside an absolutely-positioned parent: nothing extra
  }
  return d.join('');
}

function collectElements(sections) {
  const out = [];
  const walk = (els, depth) => {
    for (const el of els || []) {
      if (!el || !el.id) continue;
      out.push({ el, depth });
      if (Array.isArray(el.children)) walk(el.children, depth + 1);
    }
  };
  for (const s of sections || []) walk(s.elements, 0);
  return out;
}

/**
 * Build the full instance-scoped stylesheet for a document.
 * Every rule is prefixed with `[data-aic="<instanceId>"]`; per-breakpoint
 * overrides are emitted twice (real @media + [data-aic-bp] attribute variant).
 */
export function buildAicCss(doc, instanceId) {
  const scope = `[data-aic="${cssSafe(instanceId)}"]`;
  const rules = [];
  const bpRules = { tablet: [], mobile: [] };

  // Root + section shells.
  rules.push(`${scope}{position:relative;width:100%;}`);
  for (const section of doc?.sections || []) {
    const sid = cssSafe(section.id);
    const decls = styleDecls(section.style);
    // Absolute-mode sections size to the max child extent per breakpoint.
    rules.push(`${scope} .aic-s-${sid}{position:relative;width:100%;${decls}}`);
    for (const bp of ['desktop', 'tablet', 'mobile']) {
      const tops = orderedElements(section);
      const anyAbs = tops.some((el) => frameFor(doc, el.id, bp)?.mode === 'absolute');
      if (anyAbs) {
        let maxBottom = 0;
        for (const { el } of collectElements([section])) {
          const f = frameFor(doc, el.id, bp);
          if (f?.mode === 'absolute') {
            const bottom = (Number(f.y) || 0) + (Number(f.h) || Number(f.minH) || 0);
            if (bottom > maxBottom) maxBottom = bottom;
          }
        }
        const rule = `${scope} .aic-s-${sid}{min-height:${Math.ceil(maxBottom)}px;}`;
        if (bp === 'desktop') rules.push(rule);
        else bpRules[bp].push(rule);
      }
    }
  }

  // Elements.
  for (const { el } of collectElements(doc?.sections)) {
    const cls = `.aic-e-${cssSafe(el.id)}`;
    const base = styleDecls(el.style) + frameDecls(frameFor(doc, el.id, 'desktop'));
    rules.push(`${scope} ${cls}{${base}}`);
    for (const bp of ['tablet', 'mobile']) {
      const merged = frameFor(doc, el.id, bp);
      const override = doc?.layouts?.[bp]?.[el.id];
      if (!override) continue;
      const decl = frameDecls(merged);
      if (decl) bpRules[bp].push(`${scope} ${cls}{${decl}}`);
    }
  }

  const css = [rules.join('\n')];
  if (bpRules.tablet.length) {
    css.push(`@media (max-width:${TABLET_MAX}px){${bpRules.tablet.join('\n')}}`);
    css.push(bpRules.tablet.map((r) => r.replace(scope, `${scope}[data-aic-bp="tablet"]`)).join('\n'));
  }
  if (bpRules.mobile.length) {
    css.push(`@media (max-width:${MOBILE_MAX}px){${bpRules.mobile.join('\n')}}`);
    css.push(
      bpRules.mobile.map((r) => r.replace(scope, `${scope}[data-aic-bp="mobile"]`)).join('\n'),
      // Forced tablet preview also applies mobile rules? No — tablet shows tablet only.
    );
  }
  return css.join('\n');
}

/** Heading tag for a heading element ('h2' default, clamped h1–h6). */
export function headingTag(el) {
  return /^h[1-6]$/.test(el?.role || '') ? el.role : 'h2';
}

// ---------------------------------------------------------------------------
// Inspector draft-lifecycle helpers (pure, node-testable).
//
// A "draft" is a composition generated but NOT yet bound to the canvas block.
// Regenerating an already-inserted composition adds a version to that SAME
// composition — it must NEVER re-enter draft mode, because draft mode exposes
// Insert/Discard and Discard deletes the composition (and all versions).

/**
 * After a generation completes, decide the new draftId.
 * Returns the new composition id only when it is a genuinely uninserted draft;
 * returns '' when generation targeted the already-inserted composition.
 */
export function resolveDraftAfterGeneration(insertedId, completedId) {
  if (!completedId) return '';
  return completedId === insertedId ? '' : completedId;
}

/** A draft may only be discarded (deleted) if it is NOT the inserted composition. */
export function isDiscardableDraft(draftId, insertedId) {
  return Boolean(draftId) && draftId !== insertedId;
}

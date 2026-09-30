// Task #3371 — Static "AI generated" page class (builder_type = 'ai_static').
//
// These pages store pre-authored HTML + CSS on the i_edit_page row itself
// (static_html / static_css) and render read-only. This module is the single
// store-time choke point for that content:
//
//   - HTML is sanitized with the same parser-based sanitiser the AI Design
//     Studio V2 pipeline uses (jsdom + DOMPurify — never regex). Scripts,
//     event handlers, iframes, forms, inline styles and unsafe URLs are all
//     stripped before anything is persisted.
//   - CSS is parsed with PostCSS and every selector is rewritten under the
//     page's own wrapper, [data-static-page="<page id>"], so page styles can
//     never bleed into the tenant header/footer chrome or the admin shell.
//     (Mirrors api/_lib/aiCodeCssScope.js, with a different scope attribute
//     and @keyframes/@font-face allowed since this content is authored by
//     the platform, not a model.)
//
// Nothing in this module runs at render time: the client renderer and the
// SSR/prerender path both trust the stored values because they can only be
// written through prepareStaticPageContent (seed scripts / platform tooling —
// the generic entity API refuses static_html/static_css writes outright).

import postcss from 'postcss';
import { sanitizeAiCodeHtml } from './aiCodeHtmlSanitizer.js';

export const STATIC_PAGE_SCOPE_ATTR = 'data-static-page';

const cssSafeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');

const FORBIDDEN_SELECTOR_RE = /(^|[\s>+~,(])\s*(html|body)\b|\[data-cb\b|\[data-canvas|\.canvas-|\.cb-|#root\b|\.admin-|\[data-radix|\.Toaster/i;
const FORBIDDEN_VALUE_RE = /expression\s*\(|-moz-binding|behavior\s*:|javascript:/i;
const MAX_Z_INDEX = 1000;

// At-rules whose inner rules get scoped normally.
const RECURSIVE_ATRULES = new Set(['media', 'supports']);
// At-rules allowed to pass through unscoped (their contents are not
// selectors). @font-face is intentionally NOT allowed — fonts must come from
// the tenant's installed fonts so we never fetch third-party font URLs.
const PASSTHROUGH_ATRULES = new Set(['keyframes']);

function scopeSelector(selector, scope, rejections) {
  let sel = String(selector || '').trim();
  // Strip any pre-existing scope prefix so re-running is idempotent.
  sel = sel.replace(/\[data-static-page(?:=(?:"[^"]*"|'[^']*'|[^\]]*))?\]\s*/g, '').trim();
  if (/^:root$/i.test(sel)) return scope;
  sel = sel.replace(/^:root\b/i, '&');
  sel = sel.replace(/^(?:html\s*>?\s*)?body(?![\w-])|^html(?![\w-])/i, '&').trim();
  if (sel === '' || sel === '&') return scope;
  if (FORBIDDEN_SELECTOR_RE.test(sel.startsWith('&') ? sel.slice(1) : sel)) {
    rejections.push({ kind: 'selector', detail: selector });
    return null;
  }
  if (sel.startsWith('&')) return `${scope}${sel.slice(1)}`;
  return `${scope} ${sel}`;
}

function checkDecl(decl, rejections) {
  const prop = decl.prop.toLowerCase();
  const value = String(decl.value || '');
  if (FORBIDDEN_VALUE_RE.test(value)) {
    rejections.push({ kind: 'value', detail: `${prop}: ${value.slice(0, 120)}` });
    return false;
  }
  if (prop === 'position' && /\b(fixed|sticky)\b/i.test(value)) {
    rejections.push({ kind: 'position', detail: `position: ${value}` });
    return false;
  }
  if (prop === 'z-index') {
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && Math.abs(n) > MAX_Z_INDEX) {
      rejections.push({ kind: 'z-index', detail: `z-index: ${value}` });
      return false;
    }
  }
  if (/url\s*\(/i.test(value)) {
    // Only local fragments (SVG paint servers) survive — imagery flows
    // through sanitized <img> elements, not CSS backgrounds.
    const urls = [...value.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)].map((m) => m[2].trim());
    if (!urls.every((u) => u.startsWith('#'))) {
      rejections.push({ kind: 'url', detail: `${prop}: ${value.slice(0, 120)}` });
      return false;
    }
  }
  return true;
}

/**
 * Scope + sanitise a static page's CSS under [data-static-page="<pageId>"].
 * Returns { ok, css, rejections }; ok=false only when the CSS fails to parse.
 */
export function scopeStaticPageCss(rawCss, pageId) {
  const id = cssSafeId(pageId);
  if (!id) return { ok: false, css: '', rejections: [{ kind: 'scope', detail: 'pageId required' }] };
  const scope = `[${STATIC_PAGE_SCOPE_ATTR}="${id}"]`;
  const rejections = [];

  let root;
  try {
    root = postcss.parse(String(rawCss || ''));
  } catch (err) {
    return { ok: false, css: '', rejections: [{ kind: 'parse', detail: err.message }] };
  }

  root.walkAtRules((at) => {
    const name = at.name.toLowerCase().replace(/^-\w+-/, '');
    if (RECURSIVE_ATRULES.has(name) || PASSTHROUGH_ATRULES.has(name)) return;
    rejections.push({ kind: 'at-rule', detail: `@${at.name}${at.params ? ' ' + at.params.slice(0, 80) : ''}` });
    at.remove();
  });

  root.walkComments((c) => c.remove());

  root.walkRules((rule) => {
    // Selectors inside @keyframes are step names (from/to/%), not element
    // selectors — leave them alone; declarations are still policy-checked.
    const parentAt = rule.parent && rule.parent.type === 'atrule'
      ? rule.parent.name.toLowerCase().replace(/^-\w+-/, '')
      : null;
    if (parentAt !== 'keyframes') {
      const scoped = [];
      for (const sel of rule.selectors) {
        const s = scopeSelector(sel, scope, rejections);
        if (s) scoped.push(s);
      }
      if (!scoped.length) { rule.remove(); return; }
      rule.selectors = scoped;
    }
    rule.walkDecls((decl) => {
      if (!checkDecl(decl, rejections)) decl.remove();
    });
    if (rule.nodes.length === 0) rule.remove();
  });

  root.walkAtRules((at) => { if (!at.nodes || at.nodes.length === 0) at.remove(); });

  return { ok: true, css: root.toString().trim(), rejections };
}

/**
 * Belt-and-braces leak check: every selector in the FINAL css (including
 * inside @media/@supports, excluding @keyframes step names) must start with
 * the exact page scope.
 */
export function assertStaticPageCssScoped(css, pageId) {
  const scope = `[${STATIC_PAGE_SCOPE_ATTR}="${cssSafeId(pageId)}"]`;
  let root;
  try { root = postcss.parse(String(css || '')); }
  catch { return { ok: false, offenders: ['<unparseable>'] }; }
  const offenders = [];
  root.walkRules((rule) => {
    const parentAt = rule.parent && rule.parent.type === 'atrule'
      ? rule.parent.name.toLowerCase().replace(/^-\w+-/, '')
      : null;
    if (parentAt === 'keyframes') return;
    for (const sel of rule.selectors) {
      if (!sel.trim().startsWith(scope)) offenders.push(sel);
    }
  });
  return { ok: offenders.length === 0, offenders };
}

/**
 * Store-time preparation for an ai_static page: sanitize the HTML and scope
 * the CSS to the page id. Throws when the CSS cannot be parsed or a selector
 * survives unscoped — content must never be persisted half-safe.
 *
 * options.allowedImageHosts — URL prefixes <img src> may use (tenant storage
 * public prefix). Same-origin relative URLs are always allowed.
 */
export function prepareStaticPageContent({ html, css, pageId, allowedImageHosts = [] }) {
  const { html: cleanHtml, report } = sanitizeAiCodeHtml(html, { allowedImageHosts });
  const scoped = scopeStaticPageCss(css, pageId);
  if (!scoped.ok) {
    throw new Error(`static page CSS rejected: ${scoped.rejections.map((r) => `${r.kind}: ${r.detail}`).join('; ')}`);
  }
  const leak = assertStaticPageCssScoped(scoped.css, pageId);
  if (!leak.ok) {
    throw new Error(`static page CSS leak check failed: ${leak.offenders.join(', ')}`);
  }
  return {
    static_html: cleanHtml,
    static_css: scoped.css,
    htmlReport: report,
    cssRejections: scoped.rejections,
  };
}

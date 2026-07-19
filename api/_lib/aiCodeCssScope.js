// AI Design Studio V2 — CSS AST scoping + safety gate (Task #2904, Phase 0).
//
// Parses generated CSS with PostCSS (real AST — never string replacement) and
// rewrites EVERY selector under the composition's unique wrapper:
//
//   [data-ai-composition="<uuid>"] .hero { … }
//
// Safety policy (spec §7/§16):
//   - reject @import, @font-face, @charset, @namespace, @keyframes (animation
//     is not in scope for Phase 0), and any unknown at-rule; @media and
//     @supports recurse
//   - reject selectors that target html / body / :root outside token mapping
//     (a bare `:root` selector is REMAPPED to the wrapper so the model's
//     design tokens still work), the Canvas editor, or the admin shell
//   - strip any pre-existing [data-ai-composition=…] prefix and re-prefix
//     with the REAL instance scope (the model never controls the uuid)
//   - reject position:fixed / position:sticky, excessive z-index, CSS
//     expression(), -moz-binding, behavior:
//   - url(...) values: only local fragments (#grad) survive; all external /
//     data: URLs are removed (media flows through the asset manifest)
//
// The output is a report of everything rejected so failures are explicit —
// blocked rules are DROPPED (and listed), never silently rewritten into
// something different.

import postcss from 'postcss';

const SCOPE_ATTR = 'data-ai-composition';

// Selectors that may never appear anywhere in a generated selector.
const FORBIDDEN_SELECTOR_RE = /(^|[\s>+~,(])\s*(html|body)\b|\[data-cb\b|\[data-canvas|\.canvas-|\.cb-|#root\b|\.admin-|\[data-radix|\.Toaster/i;

const FORBIDDEN_VALUE_RE = /expression\s*\(|-moz-binding|behavior\s*:|javascript:/i;
const MAX_Z_INDEX = 1000;

const cssSafeUuid = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');

/** Strip any model-supplied [data-ai-composition=…] prefix from a selector. */
function stripExistingScope(selector) {
  return selector.replace(/\[data-ai-composition(?:=(?:"[^"]*"|'[^']*'|[^\]]*))?\]\s*/g, '').trim();
}

function scopeSelector(selector, scope, rejections) {
  let sel = stripExistingScope(selector);
  if (!sel) sel = '&'; // selector WAS the wrapper itself
  // :root → the wrapper (design tokens land on the composition root).
  if (/^:root$/i.test(sel)) return scope;
  sel = sel.replace(/^:root\b/i, '&');
  if (FORBIDDEN_SELECTOR_RE.test(sel)) {
    rejections.push({ kind: 'selector', detail: selector });
    return null;
  }
  if (sel === '&') return scope;
  if (sel.startsWith('&')) return `${scope}${sel.slice(1)}`;
  // `*` alone would be fine scoped, but keep it bounded anyway.
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
    // Only local fragment references (SVG paint servers/filters) survive.
    const urls = [...value.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)].map((m) => m[2].trim());
    if (!urls.every((u) => u.startsWith('#'))) {
      rejections.push({ kind: 'url', detail: `${prop}: ${value.slice(0, 120)}` });
      return false;
    }
  }
  if (decl.important) {
    // !important is allowed within the scope (it can't escape the wrapper),
    // but flag it for the inspector.
    rejections.push({ kind: 'important', detail: `${prop} uses !important`, warning: true });
  }
  return true;
}

const ALLOWED_NESTED_ATRULES = new Set(['media', 'supports']);

/**
 * Scope + sanitise a CSS string for one composition instance.
 * Returns { ok, css, rejections } — `ok` is false only when the CSS fails to
 * PARSE; policy violations drop the offending rule/decl and are reported in
 * `rejections` (entries with warning:true are informational).
 */
export function scopeAiCodeCss(rawCss, compositionId) {
  const uuid = cssSafeUuid(compositionId);
  if (!uuid) return { ok: false, css: '', rejections: [{ kind: 'scope', detail: 'compositionId required' }] };
  const scope = `[${SCOPE_ATTR}="${uuid}"]`;
  const rejections = [];

  let root;
  try {
    root = postcss.parse(String(rawCss || ''));
  } catch (err) {
    return { ok: false, css: '', rejections: [{ kind: 'parse', detail: err.message }] };
  }

  root.walkAtRules((at) => {
    const name = at.name.toLowerCase();
    if (ALLOWED_NESTED_ATRULES.has(name)) return; // rules inside are scoped by walkRules
    rejections.push({ kind: 'at-rule', detail: `@${at.name}${at.params ? ' ' + at.params.slice(0, 80) : ''}` });
    at.remove();
  });

  root.walkComments((c) => c.remove());

  root.walkRules((rule) => {
    // Rules directly inside a removed at-rule are already gone; a rule's
    // remaining parents can only be root/@media/@supports here.
    const scoped = [];
    for (const sel of rule.selectors) {
      const s = scopeSelector(sel, scope, rejections);
      if (s) scoped.push(s);
    }
    if (!scoped.length) { rule.remove(); return; }
    rule.selectors = scoped;

    rule.walkDecls((decl) => {
      if (!checkDecl(decl, rejections)) decl.remove();
    });
    if (rule.nodes.length === 0) rule.remove();
  });

  // Drop now-empty at-rules.
  root.walkAtRules((at) => { if (!at.nodes || at.nodes.length === 0) at.remove(); });

  return { ok: true, css: root.toString().trim(), rejections };
}

/**
 * Leak check used by tests and the pipeline belt-and-braces gate: every
 * selector in the FINAL css must start with the exact instance scope
 * (including selectors inside @media/@supports).
 */
export function assertAllSelectorsScoped(css, compositionId) {
  const scope = `[${SCOPE_ATTR}="${cssSafeUuid(compositionId)}"]`;
  let root;
  try { root = postcss.parse(String(css || '')); }
  catch { return { ok: false, offenders: ['<unparseable>'] }; }
  const offenders = [];
  root.walkRules((rule) => {
    for (const sel of rule.selectors) {
      if (!sel.trim().startsWith(scope)) offenders.push(sel);
    }
  });
  return { ok: offenders.length === 0, offenders };
}

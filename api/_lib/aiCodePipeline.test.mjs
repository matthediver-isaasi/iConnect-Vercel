// AI Design Studio V2 Phase 0 — safety-pipeline test suite (Task #2904).
//
// Covers: schema validation, HTML sanitisation (script/event-handler/iframe/
// form/style/external-URL rejection), SVG sanitisation, CSS AST scoping +
// leak prevention, manifest cross-checks, and the BNMS fixture end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateAiCodePackage,
  crossCheckManifests,
  AI_CODE_SCHEMA_VERSION,
} from './aiCodePackageSchema.js';
import { sanitizeAiCodeHtml } from './aiCodeHtmlSanitizer.js';
import { scopeAiCodeCss, assertAllSelectorsScoped } from './aiCodeCssScope.js';
import { runAiCodePipeline } from './aiCodePipeline.js';
import { BNMS_SCAN_FIXTURE } from './fixtures/bnmsScanFixture.mjs';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const SCOPE = `[data-ai-composition="${UUID}"]`;

const minimalPkg = (over = {}) => ({
  schemaVersion: AI_CODE_SCHEMA_VERSION,
  compositionType: 'section',
  title: 'Test',
  html: '<section data-ai-id="s1"><h2 data-ai-id="h1">Hi</h2></section>',
  css: '.a { color: red; }',
  ...over,
});

// ---------------------------------------------------------------- schema ---

test('schema: accepts a minimal valid package', () => {
  const r = validateAiCodePackage(minimalPkg());
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.package.responsiveTargets.desktop, 1440);
});

test('schema: rejects wrong schemaVersion, missing html, bad types', () => {
  assert.equal(validateAiCodePackage(minimalPkg({ schemaVersion: '1.0' })).ok, false);
  assert.equal(validateAiCodePackage(minimalPkg({ html: '' })).ok, false);
  assert.equal(validateAiCodePackage(minimalPkg({ compositionType: 'popup' })).ok, false);
  assert.equal(validateAiCodePackage(minimalPkg({ actions: [{ key: 'x', type: 'sql_query' }] })).ok, false);
  assert.equal(validateAiCodePackage(minimalPkg({ slots: [{ key: 'x', type: 'raw_html' }] })).ok, false);
});

test('schema: rejects duplicate manifest keys', () => {
  const r = validateAiCodePackage(minimalPkg({
    actions: [{ key: 'go', type: 'anchor' }, { key: 'go', type: 'anchor' }],
  }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /duplicated/);
});

// ------------------------------------------------------------- sanitiser ---

test('sanitiser: removes scripts, event handlers, iframes, forms, style tags', () => {
  const { html, report } = sanitizeAiCodeHtml(`
    <section data-ai-id="s"><script>alert(1)</script>
    <p onclick="x()" onmouseover="y()">ok</p>
    <iframe src="https://evil.example"></iframe>
    <object data="x"></object><embed src="x"/>
    <form action="/steal"><input name="pw"/></form>
    <style>body{display:none}</style>
    <meta http-equiv="refresh" content="0"><link rel="stylesheet" href="https://evil/x.css">
    </section>`);
  assert.doesNotMatch(html, /<script|<iframe|<object|<embed|<form|<input|<style|<meta|<link|onclick|onmouseover/i);
  assert.match(html, /<p>ok<\/p>/);
  assert.ok(report.removed.length > 0);
});

test('sanitiser: strips javascript: and unknown-scheme hrefs, keeps safe ones', () => {
  const { html } = sanitizeAiCodeHtml(`
    <a data-ai-id="a1" href="javascript:alert(1)">bad</a>
    <a data-ai-id="a2" href="https://example.org" target="_blank">good</a>
    <a data-ai-id="a3" href="#anchor">frag</a>
    <a data-ai-id="a4" href="vbscript:x">worse</a>`);
  assert.doesNotMatch(html, /javascript:|vbscript:/i);
  assert.match(html, /href="https:\/\/example\.org"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /href="#anchor"/);
});

test('sanitiser: action anchors are neutralised to href="#" and reported', () => {
  const { html, report } = sanitizeAiCodeHtml(
    '<a data-ai-id="cta" data-ai-action="find-scan" href="https://invented.example/x">Go</a>');
  assert.match(html, /data-ai-action="find-scan"/);
  assert.match(html, /href="#"/);
  assert.deepEqual(report.actionKeys, ['find-scan']);
});

test('sanitiser: external images stripped; media-library and relative kept', () => {
  const prefix = 'https://xyz.supabase.co/storage/v1/object/public/vault/';
  const { html, report } = sanitizeAiCodeHtml(`
    <img data-ai-id="i1" src="https://third-party.example/a.png" alt="x">
    <img data-ai-id="i2" src="${prefix}t1/a.png" alt="ok">
    <img data-ai-id="i3" src="/api/og-image?u=1" alt="rel">`,
  { allowedImageHosts: [prefix] });
  assert.doesNotMatch(html, /third-party\.example/);
  assert.match(html, /t1\/a\.png/);
  assert.match(html, /\/api\/og-image/);
  assert.ok(report.removed.some((r) => r.kind === 'url'));
});

test('sanitiser: SVG keeps shapes/gradients, drops scripts/foreignObject/external refs', () => {
  const { html } = sanitizeAiCodeHtml(`
    <svg data-ai-id="art" viewBox="0 0 10 10">
      <script>evil()</script>
      <foreignObject><body>html</body></foreignObject>
      <image href="https://evil.example/x.png"/>
      <use href="https://evil.example/sprite.svg#icon"/>
      <use href="#local-ok"/>
      <defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>
      <circle cx="5" cy="5" r="4" fill="url(#g)"/>
      <rect x="1" y="1" width="2" height="2" fill="url(https://evil.example/p.svg#x)"/>
    </svg>`);
  assert.doesNotMatch(html, /<script|foreignObject|<image|evil\.example/i);
  assert.match(html, /href="#local-ok"/);
  assert.match(html, /fill="url\(#g\)"/);
  assert.match(html, /<rect(?![^>]*fill=)/);
});

test('sanitiser: slot placeholders keep their keys but lose generated children', () => {
  const { html, report } = sanitizeAiCodeHtml(
    '<div data-ai-id="sl" data-iconnect-slot="document_list" data-slot-key="scan-leaflets"><p>fake list</p></div>');
  assert.match(html, /data-slot-key="scan-leaflets"/);
  assert.doesNotMatch(html, /fake list/);
  assert.deepEqual(report.slotKeys, ['scan-leaflets']);
});

test('sanitiser: inline style attributes and unknown data-* are stripped', () => {
  const { html } = sanitizeAiCodeHtml(
    '<p data-ai-id="p" style="position:fixed;top:0" data-tracker="spy">x</p>');
  assert.doesNotMatch(html, /style=|data-tracker/);
  assert.match(html, /data-ai-id="p"/);
});

// ----------------------------------------------------------- CSS scoping ---

test('css: every selector is prefixed with the instance scope', () => {
  const r = scopeAiCodeCss('.hero { color: red; } h2, .card p { margin: 0; }', UUID);
  assert.equal(r.ok, true);
  assert.ok(r.css.includes(SCOPE));
  assert.equal(assertAllSelectorsScoped(r.css, UUID).ok, true);
});

test('css: :root remaps to the wrapper (design tokens survive)', () => {
  const r = scopeAiCodeCss(':root { --x: red; } .a { color: var(--x); }', UUID);
  assert.match(r.css, new RegExp('^' + SCOPE.replace(/[[\]"]/g, '\\$&') + '\\s*\\{'));
  assert.doesNotMatch(r.css, /:root/);
});

test('css: model-supplied scope prefixes are stripped and replaced', () => {
  const r = scopeAiCodeCss('[data-ai-composition="attacker-id"] .a, [data-ai-composition] .b { color: red; }', UUID);
  assert.doesNotMatch(r.css, /attacker-id/);
  assert.equal(assertAllSelectorsScoped(r.css, UUID).ok, true);
});

test('css: rejects html/body/global/admin selectors', () => {
  const r = scopeAiCodeCss(`
    body { display: none; }
    html .x { color: red; }
    .ok, body > div { color: blue; }
    [data-cb="1"] { opacity: 0; }
    .admin-panel { display: none; }
  `, UUID);
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.css, /body|html|data-cb|admin-panel/);
  assert.match(r.css, /\.ok/); // safe member of a mixed selector list survives
  assert.ok(r.rejections.filter((x) => x.kind === 'selector').length >= 4);
});

test('css: rejects @import/@font-face/@keyframes, keeps @media scoped', () => {
  const r = scopeAiCodeCss(`
    @import url("https://evil.example/x.css");
    @font-face { font-family: X; src: url(https://evil/f.woff); }
    @keyframes spin { to { transform: rotate(1turn); } }
    @media (max-width: 640px) { .a { color: red; } }
  `, UUID);
  assert.doesNotMatch(r.css, /@import|@font-face|@keyframes|evil/);
  assert.match(r.css, /@media \(max-width: 640px\)/);
  assert.equal(assertAllSelectorsScoped(r.css, UUID).ok, true);
});

test('css: rejects position fixed/sticky, huge z-index, external url(), expression()', () => {
  const r = scopeAiCodeCss(`
    .a { position: fixed; top: 0; }
    .b { position: sticky; }
    .c { z-index: 999999; }
    .d { background: url(https://evil.example/x.png); }
    .e { width: expression(alert(1)); }
    .f { z-index: 10; clip-path: url(#clip); position: relative; }
  `, UUID);
  assert.doesNotMatch(r.css, /fixed|sticky|999999|evil|expression/);
  assert.match(r.css, /z-index: 10/);
  assert.match(r.css, /url\(#clip\)/);
});

test('css: unparseable CSS is a hard failure', () => {
  const r = scopeAiCodeCss('.a { color: red;', UUID);
  assert.equal(r.ok, false);
});

// ------------------------------------------------------------ pipeline ----

test('pipeline: HTML action key missing from manifest fails cross-check', () => {
  const r = runAiCodePipeline(minimalPkg({
    html: '<a data-ai-id="x" data-ai-action="ghost">go</a>',
    actions: [],
  }), UUID);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /action "ghost"/);
});

test('pipeline: duplicate data-ai-id fails', () => {
  const r = runAiCodePipeline(minimalPkg({
    html: '<p data-ai-id="dup">a</p><p data-ai-id="dup">b</p>',
  }), UUID);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /duplicated/);
});

test('pipeline: html with no stable ids fails', () => {
  const r = runAiCodePipeline(minimalPkg({ html: '<p>anonymous</p>' }), UUID);
  assert.equal(r.ok, false);
});

test('pipeline: html that sanitises to nothing fails explicitly', () => {
  const r = runAiCodePipeline(minimalPkg({ html: '<script>x()</script>' }), UUID);
  assert.equal(r.ok, false);
});

test('pipeline policy: any hard CSS rejection fails the WHOLE package (reject-don\'t-repair)', () => {
  // The scoper drops offending rules so it can report every violation in one
  // pass, but the pipeline must never store a silently repaired document.
  const cases = [
    '@import url("https://evil.example/x.css"); .a { color: red; }',
    '.a { position: fixed; top: 0; } .b { color: blue; }',
    '.a { z-index: 999999; }',
    '.a { background: url(https://evil.example/x.png); }',
    'body { margin: 0; } .a { color: red; }',
  ];
  for (const css of cases) {
    const r = runAiCodePipeline(minimalPkg({ css }), UUID);
    assert.equal(r.ok, false, `should hard-fail: ${css}`);
    assert.equal(r.document, null);
    assert.match(r.errors.join(' '), /CSS rejected/);
  }
  // Warning-only rejections (!important) do NOT fail the package.
  const warn = runAiCodePipeline(minimalPkg({ css: '.a { color: red !important; }' }), UUID);
  assert.equal(warn.ok, true);
  assert.ok(warn.document.sanitisation.cssRejections.every((x) => x.warning));
});

test('canvas registry: ai-code-composition never clips overflow and is auto-height', async () => {
  // The block definition lives in a JSX module (not importable under node),
  // so assert on the source: the wrapper renderers (CanvasStage /
  // CanvasPageRenderer) only render overflow:visible when the registry entry
  // sets allowOverflow — a V2 document must never be clipped.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL(
    '../../client/src/components/canvas/blocks/dynamicBlocks.jsx', import.meta.url), 'utf8');
  const entry = src.match(/\[BLOCK_TYPES\.AI_CODE_COMPOSITION\]:\s*\{[\s\S]*?\n  \},/);
  assert.ok(entry, 'AI_CODE_COMPOSITION registry entry exists');
  assert.match(entry[0], /allowOverflow:\s*true/);
  assert.match(entry[0], /autoHeight:\s*true/);
});

test('crossCheckManifests: slot key must exist in manifest', () => {
  const r = crossCheckManifests({ actions: [], slots: [] }, { actionKeys: [], slotKeys: ['s1'], aiIds: ['a'] });
  assert.equal(r.ok, false);
});

// --------------------------------------------------- BNMS fixture proof ---

test('BNMS fixture passes the full pipeline unchanged', () => {
  const r = runAiCodePipeline(BNMS_SCAN_FIXTURE, UUID);
  assert.equal(r.ok, true, r.errors.join('; '));
  const doc = r.document;
  assert.equal(doc.rendererVersion, 2);
  assert.equal(doc.compositionId, UUID);
  // Structure survived: hero, journey, safety, 6 cards, FAQ, CTA, inline SVG.
  assert.match(doc.html, /data-ai-id="scan-hero"/);
  assert.match(doc.html, /data-ai-id="scan-journey"/);
  assert.match(doc.html, /data-ai-id="scan-safety"/);
  assert.equal((doc.html.match(/class="scan-card"/g) || []).length, 6);
  assert.equal((doc.html.match(/<details/g) || []).length, 4);
  assert.match(doc.html, /<svg[^>]*viewBox="0 0 420 320"/);
  assert.match(doc.html, /linearGradient id="scanSky"/);
  // No JS or external refs anywhere.
  assert.doesNotMatch(doc.html, /<script|onerror|onclick|http:\/\//i);
  // CSS fully scoped, tokens remapped, media queries intact.
  assert.equal(assertAllSelectorsScoped(doc.css, UUID).ok, true);
  assert.match(doc.css, /--scan-brand/);
  assert.match(doc.css, /@media \(max-width: ?1024px\)/);
  assert.match(doc.css, /@media \(max-width: ?640px\)/);
  assert.doesNotMatch(doc.css, /(^|\})\s*body\s*\{/);
  // Actions cross-checked.
  assert.deepEqual([...doc.sanitisation.actionKeys].sort(), ['find-scan', 'patient-leaflets']);
  // Fixture is clean: nothing should have been removed by the sanitiser.
  assert.deepEqual(doc.sanitisation.htmlRemoved, []);
  const hardCssRejections = doc.sanitisation.cssRejections.filter((x) => !x.warning);
  assert.deepEqual(hardCssRejections, []);
});

test('fixture leak test: scoped CSS cannot style content outside the wrapper', () => {
  const r = runAiCodePipeline(BNMS_SCAN_FIXTURE, UUID);
  // Simulate a sibling block: no selector may match an unwrapped element.
  const { offenders } = assertAllSelectorsScoped(r.document.css, UUID);
  assert.deepEqual(offenders, []);
  // And a second instance gets a DIFFERENT scope — no cross-instance bleed.
  const other = runAiCodePipeline(BNMS_SCAN_FIXTURE, '999e4567-e89b-42d3-a456-426614174999');
  assert.notEqual(other.document.css, r.document.css);
  assert.doesNotMatch(other.document.css, new RegExp(UUID));
});

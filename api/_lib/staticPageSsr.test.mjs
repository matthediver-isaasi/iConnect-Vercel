// Task #3371 — SSR parity for the static "AI generated" page class.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStaticPageSsrHtml } from './staticPageSsr.js';

const page = {
  id: 'a1b2c3d4-e5f6',
  builder_type: 'ai_static',
  static_html: '<div class="g-page"><h1>AI for Membership Organisations</h1></div>',
  static_css: '[data-static-page="a1b2c3d4-e5f6"] h1 { color: #EC008C; }',
};

test('emits scoped style + wrapper matching the client renderer', () => {
  const out = buildStaticPageSsrHtml(page);
  assert.equal(
    out,
    '<style>[data-static-page="a1b2c3d4-e5f6"] h1 { color: #EC008C; }</style>' +
      '<div data-static-page="a1b2c3d4-e5f6"><div class="g-page"><h1>AI for Membership Organisations</h1></div></div>'
  );
});

test('omits the style tag when there is no CSS but keeps the scope wrapper', () => {
  const out = buildStaticPageSsrHtml({ ...page, static_css: '' });
  assert.ok(!out.includes('<style'));
  assert.ok(out.startsWith('<div data-static-page="a1b2c3d4-e5f6">'));
});

test('returns empty for non-static or empty pages', () => {
  assert.equal(buildStaticPageSsrHtml(null), '');
  assert.equal(buildStaticPageSsrHtml({ ...page, builder_type: 'canvas' }), '');
  assert.equal(buildStaticPageSsrHtml({ id: 'x', builder_type: 'ai_static' }), '');
});

test('escapes hostile page ids out of the attribute', () => {
  const out = buildStaticPageSsrHtml({ ...page, id: 'x" onmouseover="evil' });
  assert.ok(out.includes('data-static-page="xonmouseoverevil"'));
});

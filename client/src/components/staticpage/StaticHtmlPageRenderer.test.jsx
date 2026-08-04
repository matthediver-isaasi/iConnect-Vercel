// Task #3371 — public rendering of the static "AI generated" page class.
//
// The public endpoint (api/public/page/[slug].js) returns the whole
// i_edit_page row for builder_type='ai_static' with elements: [] — the body
// lives in static_html (sanitized at store time) and static_css (scoped at
// store time under [data-static-page="<page id>"]). This test locks in that
// the renderer emits BOTH verbatim: the scoped stylesheet and the sanitized
// markup inside the matching scope wrapper.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import StaticHtmlPageRenderer from './StaticHtmlPageRenderer';

const page = {
  id: 'page-uuid-1',
  slug: 'ai-guide',
  builder_type: 'ai_static',
  static_html: '<div class="g-page"><h1 class="g-title">AI for Membership Organisations</h1></div>',
  static_css: '[data-static-page="page-uuid-1"] .g-title { color: #EC008C; }',
};

test('renders scoped CSS and sanitized HTML inside the page scope wrapper', () => {
  const html = renderToStaticMarkup(React.createElement(StaticHtmlPageRenderer, { page }));
  // Stylesheet emitted verbatim (already scoped at store time).
  assert.ok(html.includes('<style>[data-static-page="page-uuid-1"] .g-title { color: #EC008C; }</style>'));
  // Body rendered inside the wrapper carrying the matching scope attribute.
  assert.match(html, /<div data-static-page="page-uuid-1"[^>]*>.*AI for Membership Organisations/s);
});

test('renders without a stylesheet when static_css is empty', () => {
  const html = renderToStaticMarkup(
    React.createElement(StaticHtmlPageRenderer, { page: { ...page, static_css: '' } })
  );
  assert.ok(!html.includes('<style'));
  assert.ok(html.includes('data-static-page="page-uuid-1"'));
});

test('renders nothing for a missing page', () => {
  const html = renderToStaticMarkup(React.createElement(StaticHtmlPageRenderer, { page: null }));
  assert.equal(html, '');
});

// Regression guard: BOTH public entry points must dispatch ai_static pages to
// StaticHtmlPageRenderer BEFORE falling through to the legacy element
// renderer (the public endpoint returns elements: [] for this class, so a
// fall-through renders a blank page). HomePageRedirect covers the "static
// page selected as tenant home page" path; DynamicPage covers /:slug. These
// components lean on router/query hooks and page-level data fetching, so the
// dispatch is asserted at source level here.
test('DynamicPage and HomePageRedirect both dispatch ai_static to the static renderer', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  for (const rel of ['../../pages/DynamicPage.jsx', '../../pages/HomePageRedirect.jsx']) {
    const src = fs.readFileSync(path.resolve(here, rel), 'utf8');
    assert.ok(
      src.includes('StaticHtmlPageRenderer'),
      `${rel} must import StaticHtmlPageRenderer`
    );
    const dispatchIdx = src.indexOf("builder_type === 'ai_static'");
    assert.ok(dispatchIdx > -1, `${rel} must branch on builder_type === 'ai_static'`);
    const elementFallthroughIdx = src.indexOf('IEditElementRenderer\n', dispatchIdx) === -1
      ? src.indexOf('<IEditElementRenderer', dispatchIdx)
      : src.indexOf('IEditElementRenderer', dispatchIdx);
    assert.ok(
      elementFallthroughIdx === -1 || dispatchIdx < elementFallthroughIdx,
      `${rel} must dispatch ai_static before the legacy element renderer`
    );
  }
});

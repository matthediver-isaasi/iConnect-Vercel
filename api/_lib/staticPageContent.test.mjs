// Task #3371 — store-time safety for the static "AI generated" page class.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeStaticPageCss,
  assertStaticPageCssScoped,
  prepareStaticPageContent,
} from './staticPageContent.js';

const PAGE_ID = 'abc123-page';
const SCOPE = `[data-static-page="${PAGE_ID}"]`;

test('scopes plain selectors under the page wrapper', () => {
  const { ok, css } = scopeStaticPageCss('.hero { color: red; } .a, .b { margin: 0; }', PAGE_ID);
  assert.ok(ok);
  assert.ok(css.includes(`${SCOPE} .hero`));
  assert.ok(css.includes(`${SCOPE} .a`));
  assert.ok(css.includes(`${SCOPE} .b`));
  assert.ok(assertStaticPageCssScoped(css, PAGE_ID).ok);
});

test('remaps :root/body to the wrapper and scopes @media rules', () => {
  const { css } = scopeStaticPageCss(
    ':root { --x: 1px; } body .k { color: blue; } @media (max-width: 600px) { .m { display: none; } }',
    PAGE_ID
  );
  assert.ok(css.includes(`${SCOPE} {`));
  assert.ok(css.includes(`${SCOPE} .k`));
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\[data-static-page="abc123-page"\] \.m/);
  assert.ok(assertStaticPageCssScoped(css, PAGE_ID).ok);
});

test('drops selectors that target chrome/admin surfaces', () => {
  const { css, rejections } = scopeStaticPageCss(
    '.ok { color: red; } div body { color: red; } .admin-shell { color: red; }',
    PAGE_ID
  );
  assert.ok(css.includes('.ok'));
  assert.ok(!css.includes('.admin-shell'));
  assert.ok(rejections.some((r) => r.kind === 'selector'));
});

test('rejects fixed/sticky positioning, external url() and @import', () => {
  const { css, rejections } = scopeStaticPageCss(
    `@import url('https://evil.example/x.css');
     .p { position: fixed; color: red; }
     .q { background: url('https://evil.example/x.png'); }`,
    PAGE_ID
  );
  assert.ok(!css.includes('fixed'));
  assert.ok(!css.includes('evil.example'));
  assert.ok(rejections.some((r) => r.kind === 'at-rule'));
  assert.ok(rejections.some((r) => r.kind === 'position'));
  assert.ok(rejections.some((r) => r.kind === 'url'));
});

test('keyframes pass through with step names intact', () => {
  const { css } = scopeStaticPageCss(
    '@keyframes spin { from { opacity: 0; } to { opacity: 1; } } .s { animation: spin 1s; }',
    PAGE_ID
  );
  assert.ok(css.includes('@keyframes spin'));
  assert.ok(css.includes('from'));
  assert.ok(assertStaticPageCssScoped(css, PAGE_ID).ok);
});

test('prepareStaticPageContent sanitizes HTML (scripts/handlers/inline styles gone)', () => {
  const out = prepareStaticPageContent({
    html: '<div class="x" style="color:red" onclick="evil()"><script>evil()</script><a href="javascript:evil()">a</a><p>keep</p></div>',
    css: '.x { color: red; }',
    pageId: PAGE_ID,
  });
  assert.ok(!out.static_html.includes('<script'));
  assert.ok(!out.static_html.includes('onclick'));
  assert.ok(!out.static_html.includes('style='));
  assert.ok(!out.static_html.includes('javascript:'));
  assert.ok(out.static_html.includes('keep'));
  assert.ok(out.static_css.startsWith(SCOPE));
});

test('prepareStaticPageContent throws on unparseable CSS', () => {
  assert.throws(() => prepareStaticPageContent({ html: '<p>x</p>', css: '.a { color: ', pageId: PAGE_ID }));
});

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let sanitizeCustomHtml;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  ({ sanitizeCustomHtml } = await import('./sanitize.js'));
});

test('retains a Google My Maps embed and useful presentation attributes', () => {
  const html = '<iframe src="https://www.google.com/maps/d/embed?mid=abc123" width="640" height="480" title="Our locations" loading="lazy"></iframe>';
  const clean = sanitizeCustomHtml(html);

  assert.match(clean, /^<iframe /);
  assert.match(clean, /src="https:\/\/www\.google\.com\/maps\/d\/embed\?mid=abc123"/);
  assert.match(clean, /width="640"/);
  assert.match(clean, /height="480"/);
  assert.match(clean, /title="Our locations"/);
  assert.match(clean, /loading="lazy"/);
});

test('retains a standard Google Maps embed route', () => {
  const clean = sanitizeCustomHtml(
    '<iframe src="https://google.com/maps/embed?pb=place-data" title="Map"></iframe>',
  );
  assert.match(clean, /<iframe /);
  assert.match(clean, /src="https:\/\/google\.com\/maps\/embed\?pb=place-data"/);
});

test('rejects deceptive, non-HTTPS, and non-embed Google iframe URLs', () => {
  const cases = [
    'http://www.google.com/maps/embed?pb=x',
    'https://www.google.com.evil.example/maps/embed?pb=x',
    'https://google.com@evil.example/maps/embed?pb=x',
    'https://www.google.com/maps/place/London',
    'https://maps.google.com/maps/embed?pb=x',
    '//www.google.com/maps/embed?pb=x',
  ];

  for (const src of cases) {
    assert.doesNotMatch(
      sanitizeCustomHtml(`<p>before</p><iframe src="${src}"></iframe><p>after</p>`),
      /iframe/i,
      src,
    );
  }
});

test('rejects unrelated iframes and strips unsafe attributes from approved maps', () => {
  const unrelated = sanitizeCustomHtml(
    '<iframe src="https://example.com/maps/embed"></iframe>',
  );
  assert.equal(unrelated, '');

  const approved = sanitizeCustomHtml(
    '<iframe src="https://www.google.com/maps/embed?pb=x" title="Map" onload="alert(1)" onclick="alert(2)" srcdoc="<script>alert(3)</script>"></iframe>',
  );
  assert.match(approved, /<iframe /);
  assert.doesNotMatch(approved, /onload|onclick|srcdoc|script|alert/i);
});

test('continues to strip existing forbidden markup', () => {
  const clean = sanitizeCustomHtml(
    '<div onclick="alert(1)">Safe text<script>alert(2)</script><form><input></form><object data="x"></object></div>',
  );
  assert.equal(clean, '<div>Safe text</div>');
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { funnelPresentationIssue, isFunnelImageUrl } from '../../shared/eventFunnelPresentation.mjs';
import { sanitizeFunnelPresentation } from './eventFunnelPresentation.js';

test('optional presentation preserves legacy steps and validates bounded addon content', () => {
  assert.equal(funnelPresentationIssue({ type: 'addon' }), null);
  assert.equal(funnelPresentationIssue({ type: 'addon', presentation: {
    heading: 'Another day?', bodyHtml: '<p><strong>Join us</strong></p>', imageUrl: '/uploads/banner.png',
  } }), null);
  for (const presentation of [null, [], { unexpected: true }, { heading: 'a'.repeat(201) },
    { bodyHtml: 'a'.repeat(20001) }, { imageUrl: 'javascript:alert(1)' }]) {
    assert.ok(funnelPresentationIssue({ type: 'addon', presentation }));
  }
  for (const type of ['source', 'event', 'condition', 'checkout', 'membership']) {
    assert.ok(funnelPresentationIssue({ type, presentation: {} }));
  }
});

test('image URLs reject active schemes, credentials and disguised external URLs', () => {
  for (const value of ['', '/images/banner.png', 'https://cdn.example.test/banner.jpg?width=100', 'http://example.test/a']) {
    assert.equal(isFunnelImageUrl(value), true, value);
  }
  for (const value of ['//evil.test/a', '/\\evil.test/a', 'javascript:alert(1)', 'data:image/svg+xml,test',
    'https://user:password@example.test/a', ' https://example.test/a', '/\nevil', 'x'.repeat(2049)]) {
    assert.equal(isFunnelImageUrl(value), false, value);
  }
});

test('server sanitizes modal formatting without mutating graph or routing', () => {
  const graph = { entry: 'source', nodes: [{ id: 'source', type: 'source', accept: 'extra' },
    { id: 'extra', type: 'addon', accept: 'checkout', presentation: {
      heading: 'Join us', imageUrl: '/banner.png',
      bodyHtml: '<h2>Another day</h2><p><strong>Welcome</strong><a href="https://example.test">Details</a></p>'
        + '<script>alert(1)</script><img src=x onerror=alert(1)><iframe src="https://evil.test"></iframe>'
        + '<a href="javascript:alert(1)" onclick="alert(1)" style="position:fixed">Bad</a>',
    } }] };
  const before = structuredClone(graph);
  const clean = sanitizeFunnelPresentation(graph);
  assert.deepEqual(graph, before);
  assert.equal(clean.nodes[1].accept, 'checkout');
  assert.equal(clean.nodes[1].presentation.imageUrl, '/banner.png');
  assert.match(clean.nodes[1].presentation.bodyHtml, /<strong>Welcome<\/strong>/);
  assert.match(clean.nodes[1].presentation.bodyHtml, /href="https:\/\/example.test"/);
  assert.doesNotMatch(clean.nodes[1].presentation.bodyHtml, /script|javascript:|onclick|onerror|iframe|<img|style=/);
});

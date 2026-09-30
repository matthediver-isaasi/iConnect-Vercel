import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./prerender.js', import.meta.url), 'utf8');
test('dashboard embeds never include persisted or resolved private data in prerender', () => {
  const start = source.indexOf('function renderCanvasBlockHtml(');
  const end = source.indexOf('// Resolve the landmark wrapper', start);
  const render = vm.runInNewContext(`${source.slice(start, end)}; renderCanvasBlockHtml`);
  const html = render({
    type: 'dynamic-widget',
    content: { widgetId: 'private-id', title: 'Private title', data: 'Private dataset', html: 'private html' },
  });
  assert.equal(html, '<p>Sign in with dashboard access to view this widget.</p>');
  const inlineTypes = source.match(/const INLINE_CANVAS_BLOCK_TYPES = new Set\(\[([\s\S]*?)\]\)/)[1];
  assert.ok(!inlineTypes.includes('dynamic-widget'));
});
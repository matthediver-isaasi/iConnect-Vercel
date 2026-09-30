// Task #3377 — rich-text dynamic slot substitution.
// Covers sanitizeSlotHtml / htmlSlotToPlainText and the richSlots-aware
// behaviour of applyDynamicSlotValues.
import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeSlotHtml, htmlSlotToPlainText } from './slotHtmlSanitizer.js';
import { applyDynamicSlotValues, extractDynamicTextSlotTokens } from './campaignService.js';

test('sanitizeSlotHtml keeps basic formatting and links', () => {
  const html = '<p>Hello <strong>world</strong> <a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a></p><ul><li>one</li></ul>';
  const out = sanitizeSlotHtml(html);
  assert.ok(out.includes('<strong>world</strong>'));
  assert.ok(out.includes('href="https://example.com"'));
  assert.ok(out.includes('<li>one</li>'));
});

test('sanitizeSlotHtml strips scripts, event handlers and javascript: URLs', () => {
  assert.equal(sanitizeSlotHtml('<script>alert(1)</script>hi'), 'hi');
  const out = sanitizeSlotHtml('<p onclick="x()">a</p><a href="javascript:alert(1)">b</a><img src="x" onerror="y()">');
  assert.ok(!out.includes('onclick'));
  assert.ok(!out.includes('javascript:'));
  assert.ok(!out.includes('<img'));
});

test('htmlSlotToPlainText flattens markup for subjects', () => {
  assert.equal(htmlSlotToPlainText('<p>Hello <strong>world</strong></p><p>Again &amp; again</p>'), 'Hello world Again & again');
  assert.equal(htmlSlotToPlainText(''), '');
});

test('applyDynamicSlotValues escapes plain slots in html mode (legacy behaviour)', () => {
  const out = applyDynamicSlotValues('<td>{{dynamic_1}}</td>', { dynamic_1: 'a <b> &\nc' }, { html: true });
  assert.equal(out, '<td>a &lt;b&gt; &amp;<br>c</td>');
});

test('applyDynamicSlotValues injects sanitized HTML for rich slots in html mode', () => {
  const out = applyDynamicSlotValues(
    '<td>{{dynamic_1}}</td>',
    { dynamic_1: '<p>Hi <em>there</em></p><script>x()</script>' },
    { html: true, richSlots: ['dynamic_1'] },
  );
  assert.ok(out.includes('<em>there</em>'));
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('&lt;'));
});

test('applyDynamicSlotValues mixes rich and plain slots independently', () => {
  const out = applyDynamicSlotValues(
    '<td>{{rich}}</td><td>{{plain}}</td>',
    { rich: '<p><strong>R</strong></p>', plain: '<b>P</b>' },
    { html: true, richSlots: ['rich'] },
  );
  assert.ok(out.includes('<strong>R</strong>'));
  assert.ok(out.includes('&lt;b&gt;P&lt;/b&gt;'));
});

test('applyDynamicSlotValues flattens rich slots to plain text in subject mode', () => {
  const out = applyDynamicSlotValues(
    'News: {{dynamic_1}}',
    { dynamic_1: '<p>Big <strong>update</strong></p>' },
    { richSlots: ['dynamic_1'] },
  );
  assert.equal(out, 'News: Big update');
});

test('applyDynamicSlotValues without richSlots keeps subjects raw (legacy)', () => {
  const out = applyDynamicSlotValues('S: {{dynamic_1}}', { dynamic_1: 'plain & simple' });
  assert.equal(out, 'S: plain & simple');
});

test('extractDynamicTextSlotTokens returns only dynamic_text tokens', () => {
  const design = {
    blocks: [
      { type: 'dynamic_text', token: 'dynamic_1' },
      { type: 'dynamic_image', token: 'dynamic_2' },
      { type: 'dynamic_button', token: 'dynamic_3', linkToken: 'dynamic_3_link' },
      { type: 'section', children: [{ type: 'dynamic_text', token: 'dynamic_4' }] },
      { type: 'columns', columns: [{ blocks: [{ type: 'dynamic_text', token: 'dynamic_5' }] }] },
    ],
  };
  const tokens = extractDynamicTextSlotTokens(design);
  assert.deepEqual([...tokens].sort(), ['dynamic_1', 'dynamic_4', 'dynamic_5']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { BLOCK_TYPES, resolveButtonStyles } from './types.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
const { designToHtml } = await import('./mjmlConverter.js');

const configuredStyles = {
  backgroundColor: '#123456',
  color: '#fedcba',
  fontSize: '18px',
  fontWeight: '700',
  borderRadius: '13px',
  textAlign: 'left',
  innerPaddingTop: '9',
  innerPaddingRight: '27',
  innerPaddingBottom: '11',
  innerPaddingLeft: '25',
  paddingTop: '2',
  paddingRight: '3',
  paddingBottom: '4',
  paddingLeft: '5',
};

const assertClientSafeButton = (html, text) => {
  const parsed = new JSDOM(html);
  const link = [...parsed.window.document.querySelectorAll('a')]
    .find((candidate) => candidate.textContent.trim() === text);
  assert.ok(link, `generated HTML contains the ${text} CTA`);
  const cell = link.closest('td');
  const span = link.querySelector('span');

  assert.match(link.getAttribute('style'), /background-color:#123456\s*!important/i);
  assert.match(link.getAttribute('style'), /color:#fedcba\s*!important/i);
  assert.match(link.getAttribute('style'), /padding:9px 27px 11px 25px/i);
  assert.match(link.getAttribute('style'), /border-radius:13px/i);
  assert.match(span.getAttribute('style'), /color:#fedcba\s*!important/i);
  assert.equal(cell.getAttribute('bgcolor'), '#123456');
  assert.match(cell.getAttribute('style'), /mso-padding-alt:9px 27px 11px 25px/i);
  assert.match(cell.getAttribute('style'), /border-radius:13px/i);
};

test('standalone CTA keeps configured delivery-safe colours, padding, and radius', () => {
  const html = designToHtml({
    blocks: [{ id: 'standalone', type: BLOCK_TYPES.BUTTON, content: 'Standalone CTA', href: 'https://example.com', styles: configuredStyles }],
  });
  assertClientSafeButton(html, 'Standalone CTA');
});

test('column CTA uses the same delivery-safe markup', () => {
  const html = designToHtml({
    blocks: [{
      id: 'columns',
      type: BLOCK_TYPES.COLUMNS,
      styles: {},
      columns: [{ id: 'column', width: '100%', blocks: [
        { id: 'column-button', type: BLOCK_TYPES.BUTTON, content: 'Column CTA', href: 'https://example.com', styles: configuredStyles },
      ] }],
    }],
  });
  assertClientSafeButton(html, 'Column CTA');
});

test('dynamic CTA preserves tokens and uses the same delivery-safe markup', () => {
  const html = designToHtml({
    blocks: [{
      id: 'dynamic',
      type: BLOCK_TYPES.DYNAMIC_BUTTON,
      token: 'dynamic_cta_text',
      linkToken: 'dynamic_cta_link',
      content: 'Fallback CTA',
      href: 'https://example.com',
      styles: configuredStyles,
    }],
  });
  assertClientSafeButton(html, '{{dynamic_cta_text}}');
  assert.match(html, /href="\{\{dynamic_cta_link\}\}"/);
  assert.match(html, /DYN_BLOCK:START:dynamic_cta_text/);
});

test('legacy partial CTA styles resolve to the same safe defaults used by preview and output', () => {
  const effective = resolveButtonStyles({ backgroundColor: '#654321' });
  assert.deepEqual(effective, {
    backgroundColor: '#654321',
    color: '#ffffff',
    fontFamily: '',
    fontSize: '16px',
    fontWeight: 'bold',
    borderRadius: '4px',
    textAlign: 'center',
    innerPadding: '12px 24px 12px 24px',
    innerPaddingValues: {
      top: '12',
      right: '24',
      bottom: '12',
      left: '24',
    },
  });

  const html = designToHtml({
    blocks: [{ id: 'legacy', type: BLOCK_TYPES.BUTTON, content: 'Legacy CTA', href: '#', styles: { backgroundColor: '#654321' } }],
  });
  const link = [...new JSDOM(html).window.document.querySelectorAll('a')]
    .find((candidate) => candidate.textContent.trim() === 'Legacy CTA');
  assert.match(link.getAttribute('style'), /padding:12px 24px 12px 24px/i);
  assert.match(link.getAttribute('style'), /color:#ffffff\s*!important/i);
  assert.match(link.getAttribute('style'), /border-radius:4px/i);
});

test('legacy CTA with one populated padding side keeps safe defaults for missing sides', () => {
  const effective = resolveButtonStyles({ innerPaddingTop: '20' });
  assert.equal(effective.innerPadding, '20px 24px 12px 24px');
  assert.deepEqual(effective.innerPaddingValues, {
    top: '20',
    right: '24',
    bottom: '12',
    left: '24',
  });
});
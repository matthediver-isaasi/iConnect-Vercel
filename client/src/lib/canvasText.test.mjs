// Task #2382 — unit tests for Canvas Builder page text extraction used by the
// member AI knowledge base. Run with: node --test client/src/lib/canvasText.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCanvasPageText, collectCanvasSymbolIds } from './canvasText.js';

const design = (children) => ({
  version: 1,
  root: { sections: [{ id: 'root-section', children }] },
});

test('empty / malformed designs yield empty text', () => {
  assert.equal(extractCanvasPageText(null), '');
  assert.equal(extractCanvasPageText({}), '');
  assert.equal(extractCanvasPageText({ root: {} }), '');
  assert.equal(extractCanvasPageText(design([])), '');
});

test('extracts rich-text HTML as stripped prose', () => {
  const d = design([
    { id: 'a', type: 'text', content: { html: '<p>Hello <strong>world</strong></p>' } },
  ]);
  assert.equal(extractCanvasPageText(d), 'Hello world');
});

test('extracts common text fields across block types', () => {
  const d = design([
    { id: 'h', type: 'hero', content: { headline: 'Big Title', subheadline: 'A tagline' } },
    { id: 'b', type: 'button', content: { label: 'Click me' } },
    { id: 'i', type: 'image', content: { alt: 'A photo of the team' } },
  ]);
  const text = extractCanvasPageText(d);
  for (const expected of ['Big Title', 'A tagline', 'Click me', 'A photo of the team']) {
    assert.ok(text.includes(expected), `expected text to include "${expected}"`);
  }
});

test('walks nested arrays and children (accordion, columns)', () => {
  const d = design([
    {
      id: 'acc',
      type: 'accordion',
      content: { items: [{ q: 'What is it?', a: 'It is a thing.' }] },
    },
    {
      id: 'col',
      type: 'columns',
      children: [
        { id: 'c1', type: 'text', content: { html: '<div>Column body</div>' } },
      ],
    },
  ]);
  const text = extractCanvasPageText(d);
  for (const expected of ['What is it?', 'It is a thing.', 'Column body']) {
    assert.ok(text.includes(expected), `expected text to include "${expected}"`);
  }
});

test('resolves referenced symbol text from symbolsById', () => {
  const d = design([
    { id: 's', type: 'symbol', content: { symbolId: 'sym-1' } },
    { id: 't', type: 'text', content: { html: '<p>Page body</p>' } },
  ]);
  const symbolsById = {
    'sym-1': {
      id: 'sym-1',
      design: design([
        { id: 'sh', type: 'text', content: { html: '<p>Shared footer text</p>' } },
      ]),
    },
  };
  const text = extractCanvasPageText(d, symbolsById);
  assert.ok(text.includes('Shared footer text'));
  assert.ok(text.includes('Page body'));
});

test('missing symbol design is silently skipped (never renders)', () => {
  const d = design([{ id: 's', type: 'symbol', content: { symbolId: 'absent' } }]);
  assert.equal(extractCanvasPageText(d, {}), '');
});

test('duplicate strings are de-duplicated', () => {
  const d = design([
    { id: 'a', type: 'text', content: { html: 'Repeated' } },
    { id: 'b', type: 'text', content: { html: 'Repeated' } },
  ]);
  assert.equal(extractCanvasPageText(d), 'Repeated');
});

test('collectCanvasSymbolIds returns top-level symbol references', () => {
  const d = design([
    { id: 's1', type: 'symbol', content: { symbolId: 'sym-a' } },
    { id: 't', type: 'text', content: { html: 'x' } },
    { id: 's2', type: 'symbol', content: { symbolId: 'sym-b' } },
  ]);
  assert.deepEqual([...collectCanvasSymbolIds(d)].sort(), ['sym-a', 'sym-b']);
  assert.deepEqual([...collectCanvasSymbolIds(null)], []);
});

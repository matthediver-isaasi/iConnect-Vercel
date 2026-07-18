/**
 * AI Composition render helper tests (Task #2849).
 *
 * Proves the client-side rendering guarantees:
 * - buildAicCss scopes EVERY selector to the instance ([data-aic="id"]) so
 *   generated CSS can never leak into the host page;
 * - unsafe CSS (url(), var(), !important, javascript:, non-allowlisted keys)
 *   is dropped at render time even if it somehow reached the document;
 * - unsafe HTML tags/attributes are stripped, allowlisted formatting kept;
 * - DOM order follows readingOrder; breakpoint frames inherit desktop→tablet→
 *   mobile and emit both @media and forced-preview attribute variants.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeAicStyle,
  sanitizeAicHtml,
  orderedElements,
  frameFor,
  buildAicCss,
  headingTag,
  resolveDraftAfterGeneration,
  isDiscardableDraft,
} from './aiCompositionRender.js';

test('sanitizeAicStyle drops unsafe and non-allowlisted values', () => {
  const out = sanitizeAicStyle({
    color: '#fff',
    backgroundImage: 'url(https://evil.example/x.png)',
    position: 'fixed',
    fontSize: '18px !important',
    fontFamily: 'var(--steal)',
    padding: '12px',
    transform: 'translateX(10px) rotate(3deg)',
    clipPath: 'polygon(0 0, 100% 0, 100% 100%)',
    behavior: 'url(#default#userData)',
  });
  assert.deepEqual(Object.keys(out).sort(), ['clipPath', 'color', 'padding', 'transform']);
});

test('sanitizeAicStyle allows only gradient backgroundImage and safe transforms', () => {
  assert.equal(
    sanitizeAicStyle({ backgroundImage: 'linear-gradient(90deg,#000,#fff)' }).backgroundImage,
    'linear-gradient(90deg,#000,#fff)',
  );
  assert.equal(sanitizeAicStyle({ transform: 'matrix(1,0,0,1,50,50)' }).transform, undefined);
});

test('sanitizeAicHtml strips scripts, attributes and unknown tags', () => {
  const dirty = '<p onclick="x()">Hi <strong>there</strong></p><script>alert(1)</script><iframe src="x"></iframe><span style="color:red">ok</span>';
  const clean = sanitizeAicHtml(dirty);
  assert.equal(clean, '<p>Hi <strong>there</strong></p>alert(1)<span>ok</span>');
  assert.ok(!/onclick|<script|<iframe|style=/.test(clean));
});

const doc = {
  sections: [{
    id: 'sec1',
    readingOrder: ['b', 'a'],
    elements: [
      { id: 'a', type: 'paragraph', style: { color: '#111' } },
      { id: 'b', type: 'heading', role: 'h1', style: { fontSize: '40px' } },
    ],
  }],
  layouts: {
    desktop: {
      a: { mode: 'flow', w: 600 },
      b: { mode: 'flex', w: 800, flex: { direction: 'row', gap: 16 } },
    },
    tablet: { b: { flex: { direction: 'column', gap: 8 } } },
    mobile: { a: { w: 320 } },
  },
};

test('orderedElements follows readingOrder, stragglers appended', () => {
  assert.deepEqual(orderedElements(doc.sections[0]).map((e) => e.id), ['b', 'a']);
  assert.deepEqual(
    orderedElements({ elements: doc.sections[0].elements, readingOrder: ['a'] }).map((e) => e.id),
    ['a', 'b'],
  );
});

test('frameFor inherits desktop → tablet → mobile', () => {
  assert.equal(frameFor(doc, 'a', 'desktop').w, 600);
  assert.equal(frameFor(doc, 'a', 'tablet').w, 600); // no tablet override
  assert.equal(frameFor(doc, 'a', 'mobile').w, 320);
  assert.equal(frameFor(doc, 'b', 'tablet').mode, 'flex'); // mode inherited
  assert.deepEqual(frameFor(doc, 'b', 'tablet').flex, { direction: 'column', gap: 8 });
});

test('buildAicCss scopes every rule to the instance', () => {
  const css = buildAicCss(doc, 'blk-42');
  const selectors = css
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('@media') && !l.startsWith('}'))
    .map((l) => l.slice(0, l.indexOf('{')))
    .filter(Boolean);
  for (const sel of selectors) {
    assert.ok(sel.includes('[data-aic="blk-42"]'), `unscoped selector: ${sel}`);
  }
});

test('buildAicCss emits @media and forced-preview breakpoint variants', () => {
  const css = buildAicCss(doc, 'blk-42');
  assert.ok(css.includes('@media (max-width:1024px)'));
  assert.ok(css.includes('@media (max-width:640px)'));
  assert.ok(css.includes('[data-aic="blk-42"][data-aic-bp="tablet"]'));
  assert.ok(css.includes('[data-aic="blk-42"][data-aic-bp="mobile"]'));
});

test('buildAicCss sanitises instance ids and element styles', () => {
  const css = buildAicCss(doc, 'x"]{}<script>');
  assert.ok(!css.includes('<script>'));
  const hostile = {
    sections: [{
      id: 's',
      readingOrder: ['e'],
      elements: [{ id: 'e', type: 'paragraph', style: { color: 'red;} body{display:none' } }],
    }],
    layouts: { desktop: { e: { mode: 'flow' } }, tablet: {}, mobile: {} },
  };
  const css2 = buildAicCss(hostile, 'ok');
  assert.ok(!css2.includes('body{display:none'));
});

test('headingTag clamps to h1–h6 with h2 default', () => {
  assert.equal(headingTag({ role: 'h1' }), 'h1');
  assert.equal(headingTag({ role: 'h9' }), 'h2');
  assert.equal(headingTag({}), 'h2');
});

// --- Draft lifecycle guards (regenerate must never expose destructive draft controls) ---

test('resolveDraftAfterGeneration: fresh generation (no inserted composition) becomes a draft', () => {
  assert.equal(resolveDraftAfterGeneration('', 'comp-1'), 'comp-1');
});

test('resolveDraftAfterGeneration: regenerating the INSERTED composition does NOT re-enter draft mode', () => {
  assert.equal(resolveDraftAfterGeneration('comp-1', 'comp-1'), '');
});

test('resolveDraftAfterGeneration: a new draft generated while one is inserted stays a draft', () => {
  assert.equal(resolveDraftAfterGeneration('comp-1', 'comp-2'), 'comp-2');
});

test('resolveDraftAfterGeneration: no completed id yields no draft', () => {
  assert.equal(resolveDraftAfterGeneration('comp-1', ''), '');
  assert.equal(resolveDraftAfterGeneration('', undefined), '');
});

test('isDiscardableDraft: a true uninserted draft is discardable', () => {
  assert.equal(isDiscardableDraft('comp-2', 'comp-1'), true);
  assert.equal(isDiscardableDraft('comp-2', ''), true);
});

test('isDiscardableDraft: the inserted composition is NEVER discardable', () => {
  assert.equal(isDiscardableDraft('comp-1', 'comp-1'), false);
});

test('isDiscardableDraft: empty draft is not discardable', () => {
  assert.equal(isDiscardableDraft('', 'comp-1'), false);
  assert.equal(isDiscardableDraft('', ''), false);
});

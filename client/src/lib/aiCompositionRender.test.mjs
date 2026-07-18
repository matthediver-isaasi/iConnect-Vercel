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
  serializeAicCssValue,
  sanitizeAicStyle,
  sanitizeAicHtml,
  orderedElements,
  frameFor,
  buildAicCss,
  headingTag,
  resolveDraftAfterGeneration,
  isDiscardableDraft,
  aicLinkHref,
  aicLinkTarget,
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

// ---------------------------------------------------------------------------
// aicLinkHref / aicLinkTarget (Phase 2 — record-ID links, never invented URLs)
// ---------------------------------------------------------------------------

test('aicLinkHref: external http(s) passes, anything else rejected', () => {
  assert.equal(aicLinkHref({ kind: 'external', url: 'https://example.com/x' }), 'https://example.com/x');
  assert.equal(aicLinkHref({ kind: 'external', url: 'javascript:alert(1)' }), null);
  assert.equal(aicLinkHref({ kind: 'external' }), null);
});

test('aicLinkHref: email/tel/anchor', () => {
  assert.equal(aicLinkHref({ kind: 'email', address: 'a@b.co' }), 'mailto:a@b.co');
  assert.equal(aicLinkHref({ kind: 'tel', number: '+441onetwo' }), 'tel:+441onetwo');
  assert.equal(aicLinkHref({ kind: 'anchor', anchorId: 'pricing' }), '#pricing');
  assert.equal(aicLinkHref({ kind: 'anchor', anchorId: 'bad id' }), null);
});

test('aicLinkHref: internal kinds resolve only from safe identifiers', () => {
  assert.equal(aicLinkHref({ kind: 'page', pageId: 'x', slug: 'about-us' }), '/about-us');
  assert.equal(aicLinkHref({ kind: 'page', pageId: 'x' }), null);
  assert.equal(aicLinkHref({ kind: 'page', slug: '../etc' }), null);
  assert.equal(
    aicLinkHref({ kind: 'event_registration', eventId: 'abc-123' }),
    '/EventDetails?id=abc-123',
  );
  assert.equal(aicLinkHref({ kind: 'form', formId: 'f', slug: 'contact' }), '/FormView?slug=contact');
  assert.equal(aicLinkHref({ kind: 'form', formId: 'f' }), null);
  assert.equal(
    aicLinkHref({ kind: 'membership_application', tierId: 'tier-1' }),
    '/MembershipApplication?tier=tier-1',
  );
  assert.equal(aicLinkHref({ kind: 'membership_application' }), '/MembershipApplication');
  assert.equal(aicLinkHref({ kind: 'document', fileId: 'f1' }), null);
  assert.equal(aicLinkHref(null), null);
  assert.equal(aicLinkHref({ kind: 'nope' }), null);
});

test('aicLinkTarget: only external opens a new tab', () => {
  assert.equal(aicLinkTarget({ kind: 'external', url: 'https://x.y' }), '_blank');
  assert.equal(aicLinkTarget({ kind: 'page', slug: 'a' }), undefined);
});

// ---------------------------------------------------------------------------
// Task #2893: unit serialization, section min-height, background/positioning.
// ---------------------------------------------------------------------------

test('serializeAicCssValue: {value,unit} objects, px defaults, unitless keys', () => {
  assert.equal(serializeAicCssValue('fontSize', { value: 16, unit: 'px' }), '16px');
  assert.equal(serializeAicCssValue('padding', { value: 1.5, unit: 'rem' }), '1.5rem');
  assert.equal(serializeAicCssValue('fontSize', { value: 'big', unit: 'px' }), null);
  assert.equal(serializeAicCssValue('fontSize', { value: 16, unit: 'pt' }), null);
  assert.equal(serializeAicCssValue('fontSize', ['16px']), null);
  assert.equal(serializeAicCssValue('fontSize', 24), '24px');
  assert.equal(serializeAicCssValue('gap', '12'), '12px');
  assert.equal(serializeAicCssValue('lineHeight', 1.5), '1.5');
  assert.equal(serializeAicCssValue('fontWeight', 700), '700');
  assert.equal(serializeAicCssValue('opacity', '0.8'), '0.8');
  assert.equal(serializeAicCssValue('color', '#fff'), '#fff');
  assert.equal(serializeAicCssValue('fontSize', ''), null);
});

test('sanitizeAicStyle serializes objects and bare numbers instead of "[object Object]"', () => {
  const out = sanitizeAicStyle({
    fontSize: { value: 32, unit: 'px' },
    padding: 12,
    lineHeight: 1.4,
    color: { value: 'red' }, // invalid object → dropped, never "[object Object]"
  });
  assert.equal(out.fontSize, '32px');
  assert.equal(out.padding, '12px');
  assert.equal(out.lineHeight, '1.4');
  assert.equal(out.color, undefined);
  assert.ok(!JSON.stringify(out).includes('object Object'));
});

const absDoc = {
  sections: [{
    id: 's1',
    readingOrder: ['bg', 'wrap'],
    elements: [
      { id: 'bg', type: 'background', style: { backgroundColor: '#001122' } },
      {
        id: 'wrap',
        type: 'container',
        children: [{ id: 'chip', type: 'label', content: { text: 'Hi' } }],
      },
    ],
  }],
  layouts: {
    desktop: {
      bg: { mode: 'absolute', x: 0, y: 0, w: null, h: null }, // incomplete geometry
      wrap: { mode: 'flow', w: 1200 },
      chip: { mode: 'absolute', x: 10, y: 10, w: 80, h: 24 },
    },
  },
};

test('buildAicCss: incomplete-geometry backgrounds cover the section, never intercept clicks', () => {
  const css = buildAicCss(absDoc, 'inst');
  const bgRule = css.split('}').find((r) => r.includes('.aic-e-bg{'));
  assert.ok(bgRule.includes('pointer-events:none;'));
  assert.ok(bgRule.includes('position:absolute;inset:0;z-index:0;'));
});

test('buildAicCss: containers with absolute children get position:relative', () => {
  const css = buildAicCss(absDoc, 'inst');
  const wrapRule = css.split('}').find((r) => r.includes('.aic-e-wrap{'));
  assert.ok(wrapRule.includes('position:relative;'));
});

test('buildAicCss: null-geometry frames never emit a phantom zero min-height', () => {
  const css = buildAicCss(absDoc, 'inst');
  assert.ok(!/min-height:0px/.test(css));
  // chip (y:10 + h:24) is nested, not top-level; bg is top-level absolute but
  // has no numeric geometry — with a complete top-level frame the height returns:
  const okDoc = JSON.parse(JSON.stringify(absDoc));
  okDoc.layouts.desktop.bg = { mode: 'absolute', x: 0, y: 0, w: 1200, h: 480 };
  const css2 = buildAicCss(okDoc, 'inst');
  assert.ok(css2.includes('min-height:480px'));
});

test('buildAicCss: child absolute only at mobile gets breakpoint-scoped position:relative on the container', () => {
  const bpDoc = {
    sections: [{
      id: 's1',
      readingOrder: ['wrap'],
      elements: [{
        id: 'wrap',
        type: 'container',
        children: [{ id: 'chip', type: 'label', content: { text: 'Hi' } }],
      }],
    }],
    layouts: {
      desktop: {
        wrap: { mode: 'flow', w: 1200 },
        chip: { mode: 'flow', w: 80 },
      },
      mobile: {
        chip: { mode: 'absolute', x: 10, y: 10, w: 80, h: 24 },
      },
    },
  };
  const css = buildAicCss(bpDoc, 'inst');
  const baseWrap = css.split('\n').find((r) => r.startsWith('[data-aic="inst"] .aic-e-wrap{'));
  assert.ok(!baseWrap.includes('position:relative'), 'no relative on desktop base rule');
  const mobileMedia = css.split('\n').find((r) => r.startsWith('@media') && r.includes('.aic-e-wrap{'));
  assert.ok(mobileMedia && mobileMedia.includes('position:relative;'), 'mobile media rule makes container relative');
  assert.ok(css.includes('[data-aic-bp="mobile"] .aic-e-wrap{position:relative;'), 'forced-preview variant too');
});

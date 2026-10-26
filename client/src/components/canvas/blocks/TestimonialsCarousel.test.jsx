import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { normalizeTestimonialsCarousel as normalize, testimonialCountForWidth } from '../../../lib/testimonialsCarousel.js';
import { createBlock, normalizeCanvasDesign } from '../../../lib/canvasDesign.js';

const dom = new JSDOM('<html><body></body></html>');
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
let width = 1200;
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => width });
const observers = new Set();
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; observers.add(this); }
  observe() {}
  disconnect() { observers.delete(this); }
};
let reduced = false;
const mediaListeners = new Set();
window.matchMedia = () => ({
  get matches() { return reduced; },
  addEventListener: (_, cb) => mediaListeners.add(cb),
  removeEventListener: (_, cb) => mediaListeners.delete(cb),
});
Object.defineProperty(document, 'hidden', { value: false });
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { default: Carousel } = await import('./TestimonialsCarousel.jsx');

test('bounded settings preserve legacy absence and survive JSON/layout normalization', () => {
  assert.equal(normalize(undefined), null);
  assert.equal(normalize([]), null);
  const settings = normalize({ perPage: { desktop: 99, tablet: -1, mobile: '2' }, autoplaySeconds: Infinity, transitionMs: -1, arrows: 'false' });
  assert.deepEqual(settings.perPage, { desktop: 12, tablet: 1, mobile: 2 });
  assert.equal(settings.autoplaySeconds, 0);
  assert.equal(settings.transitionMs, 0);
  assert.equal(settings.arrows, true);
  assert.equal(testimonialCountForWidth(settings, 639), 2);
  assert.equal(testimonialCountForWidth(settings, 640), 1);
  assert.equal(testimonialCountForWidth(settings, 1024), 12);
  const block = createBlock('testimonials');
  for (const layout of ['carousel', 'single', 'grid', 'carousel']) {
    block.content = { ...block.content, layout, carousel: settings };
    const saved = normalizeCanvasDesign(JSON.parse(JSON.stringify({ version: 1, root: { sections: [{ id: 'root', children: [block] }] } })));
    assert.deepEqual(saved.root.sections[0].children[0].content.carousel, settings);
  }
  const legacy = createBlock('testimonials');
  assert.equal(legacy.content.carousel, undefined);
});

test('page navigation, responsive width, partial page, edits, editor safety and timer lifecycle', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let options = { loop: false };
  let editor = false;
  let total = 7;
  const render = () => act(async () => root.render(<Carousel settings={normalize(options)} asEditor={editor}>
    {Array.from({ length: total }, (_, i) => <figure key={i}>Quote {i + 1}</figure>)}
  </Carousel>));
  const page = () => Number(container.querySelector('[data-page]').dataset.page);
  const click = (label) => act(async () => container.querySelector(`[aria-label="${label}"]`).click());
  const key = (value) => act(async () => container.firstChild.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true })));
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map();
  let id = 0;
  try {
    await render();
    assert.equal(container.firstChild.dataset.perPage, '3');
    await click('Next testimonials');
    await click('Next testimonials');
    assert.equal(page(), 3);
    assert.equal(container.querySelector('[aria-hidden="false"]').textContent, 'Quote 7');
    assert.equal(container.querySelector('[aria-label="Next testimonials"]').disabled, true);
    await key('Home');
    assert.equal(page(), 1);
    options.loop = true;
    await render();
    await key('ArrowLeft');
    assert.equal(page(), 3);
    width = 375;
    await act(async () => observers.forEach((o) => o.cb()));
    assert.equal(container.firstChild.dataset.perPage, '1');
    await key('End');
    assert.equal(page(), 7);
    total = 2;
    await render();
    assert.equal(page(), 2);
    globalThis.setTimeout = (cb) => { timers.set(++id, cb); return id; };
    globalThis.clearTimeout = (timer) => timers.delete(timer);
    options.autoplaySeconds = 2;
    await render();
    assert.equal(timers.size, 1);
    await act(async () => { const cb = [...timers.values()][0]; timers.clear(); cb(); });
    assert.equal(page(), 1);
    await act(async () => container.firstChild.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
    assert.equal(timers.size, 0);
    await act(async () => container.firstChild.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true })));
    assert.equal(timers.size, 1);
    await act(async () => container.firstChild.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true })));
    assert.equal(timers.size, 0);
    await act(async () => container.firstChild.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
    reduced = true;
    await act(async () => mediaListeners.forEach((cb) => cb()));
    assert.equal(timers.size, 0);
    reduced = false;
    await act(async () => mediaListeners.forEach((cb) => cb()));
    editor = true;
    await render();
    assert.equal(timers.size, 0);
    const before = page();
    await key('ArrowRight');
    assert.equal(page(), before);
    assert.equal(container.querySelector('[aria-label="Next testimonials"]').disabled, true);
    editor = false;
    total = 1;
    await render();
    assert.equal(timers.size, 0);
    assert.equal(container.querySelector('[aria-label="Next testimonials"]'), null);
  } finally {
    await act(async () => root.unmount());
    assert.equal(timers.size, 0);
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
    container.remove();
  }
});

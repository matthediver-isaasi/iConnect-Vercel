import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORM_PAGE_NAVIGATED_MESSAGE,
  isFormEmbedMessage,
  measureFormContent,
  observeFormEmbedContent,
  scrollFormPageTarget,
} from './formEmbedRuntime.js';

function fixture() {
  let height = 1200;
  let resize;
  let disconnected = false;
  const messages = [];
  const frames = new Map();
  let id = 0;
  const root = {
    getBoundingClientRect: () => ({ height }),
    get scrollHeight() { return height; },
  };
  const win = {
    location: { origin: 'https://example.test', href: 'https://example.test/page' },
    parent: { postMessage: (...args) => messages.push(args) },
    document: { documentElement: { scrollHeight: 2000 } },
    requestAnimationFrame: callback => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: key => frames.delete(key),
    ResizeObserver: class {
      constructor(callback) { resize = callback; }
      observe(element) { assert.equal(element, root); }
      disconnect() { disconnected = true; }
    },
  };
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback());
  };
  return {
    root, win, messages, flush, frames,
    setHeight(value) { height = value; resize(); },
    get disconnected() { return disconnected; },
  };
}

test('intrinsic measurement ignores the viewport floor and follows delayed grow/shrink without scrolling', () => {
  const f = fixture();
  const runtime = observeFormEmbedContent(f.root, f.win);
  f.flush();
  for (const height of [320, 1500, 280]) {
    f.setHeight(height);
    runtime.schedule();
    runtime.schedule();
    assert.equal(f.frames.size, 1, 'reports coalesce');
    f.flush();
    assert.equal(measureFormContent(f.root), height);
  }
  assert.deepEqual(f.messages.map(([message]) => message.height), [1200, 320, 1500, 280]);
  assert.ok(f.messages.every(([message]) => message.type === 'iconn-form-resize'));
  runtime.dispose();
});

test('successful equal-height navigation reports height then one origin-limited navigation signal', () => {
  const f = fixture();
  const runtime = observeFormEmbedContent(f.root, f.win);
  f.flush();
  f.messages.length = 0;
  runtime.navigated();
  runtime.schedule();
  f.flush();
  assert.deepEqual(f.messages, [
    [{ type: 'iconn-form-resize', height: 1200 }, '*'],
    [{ type: FORM_PAGE_NAVIGATED_MESSAGE, height: 1200 }, 'https://example.test'],
  ]);
  f.setHeight(1200);
  f.flush();
  assert.equal(f.messages.length, 2, 'viewport/observer echo is deduplicated');
  runtime.dispose();
});

test('cleanup cancels pending measurements and navigation', () => {
  const f = fixture();
  const runtime = observeFormEmbedContent(f.root, f.win);
  runtime.navigated();
  runtime.dispose();
  f.flush();
  runtime.schedule();
  assert.deepEqual(f.messages, []);
  assert.equal(f.frames.size, 0);
  assert.equal(f.disconnected, true);
});

test('direct embed route retains standalone navigation scrolling', () => {
  const f = fixture();
  const scrolls = [];
  f.win.parent = f.win;
  f.win.postMessage = (...args) => f.messages.push(args);
  f.win.scrollTo = options => scrolls.push(options);
  const runtime = observeFormEmbedContent(f.root, f.win);
  f.flush();
  assert.deepEqual(scrolls, []);
  runtime.navigated();
  f.flush();
  assert.deepEqual(scrolls, [{ top: 0, behavior: 'smooth' }]);
  assert.ok(f.messages.every(([message]) => message.type !== FORM_PAGE_NAVIGATED_MESSAGE));
  runtime.dispose();
});

test('host checks both the exact iframe source and the expected origin', () => {
  const f = fixture();
  const source = {};
  const iframe = { contentWindow: source };
  const event = { source, origin: 'https://example.test' };
  assert.equal(isFormEmbedMessage(event, iframe, '/embed/form/test', f.win), true);
  assert.equal(isFormEmbedMessage({ ...event, source: {} }, iframe, '/embed/form/test', f.win), false);
  assert.equal(isFormEmbedMessage({ ...event, origin: 'https://evil.test' }, iframe, '/embed/form/test', f.win), false);
});

test('navigation scroll clears stacked sticky chrome', () => {
  const scrolls = [];
  const headers = [
    { position: 'sticky', top: 0, bottom: 64 },
    { position: 'fixed', top: 64, bottom: 100 },
    { position: 'static', top: 0, bottom: 300 },
    { position: 'sticky', top: 1000, bottom: 1100 },
  ].map(rect => ({ ...rect, getBoundingClientRect: () => rect }));
  const target = {
    getBoundingClientRect: () => ({ top: -600 }),
    ownerDocument: { querySelectorAll: () => headers },
  };
  scrollFormPageTarget(target, {
    getComputedStyle: element => element,
    innerHeight: 800,
    scrollY: 1400,
    scrollTo: options => scrolls.push(options),
  });
  assert.deepEqual(scrolls, [{ top: 684, behavior: 'auto' }]);
});
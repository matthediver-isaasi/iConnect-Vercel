import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORM_PAGE_NAVIGATED_MESSAGE,
  formEmbedPaymentViewportHeight,
  isFormEmbedMessage,
  measureFormContent,
  observeFormEmbedContent,
  scrollFormPageTarget,
} from './formEmbedRuntime.js';

function fixture() {
  let height = 1200;
  let resize;
  let disconnected = false;
  let overlaysDisconnected = false;
  let mutated;
  let paymentVisible = false;
  let payment = {};
  const listeners = new Map();
  const body = { querySelector: () => paymentVisible ? payment : null };
  const messages = [];
  const frames = new Map();
  let id = 0;
  const root = {
    ownerDocument: { body },
    getBoundingClientRect: () => ({ height }),
    get scrollHeight() { return height; },
  };
  const win = {
    innerWidth: 900,
    innerHeight: 2000,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
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
    MutationObserver: class {
      constructor(callback) { mutated = callback; }
      observe(element, options) {
        assert.equal(element, body);
        assert.deepEqual(options, { childList: true });
      }
      disconnect() { overlaysDisconnected = true; }
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
    mutateBody() { mutated(); },
    setPaymentVisible(value) { paymentVisible = value; mutated(); },
    replacePayment() { payment = {}; paymentVisible = true; mutated(); },
    resizeViewport(width, assignedHeight) {
      win.innerWidth = width;
      win.innerHeight = assignedHeight;
      listeners.get('resize')?.();
    },
    get listeners() { return listeners; },
    get overlaysDisconnected() { return overlaysDisconnected; },
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
  assert.equal(f.overlaysDisconnected, true);
  assert.equal(f.listeners.size, 0);
});

test('delayed body overlay reserves an independent viewport, stays stable, then releases on actual removal', () => {
  const f = fixture();
  const runtime = observeFormEmbedContent(f.root, f.win);
  f.setHeight(240);
  f.flush();
  f.setPaymentVisible(true);
  f.flush();
  assert.equal(f.messages.at(-1)[0].height, 720);
  // A viewport-sized provider iframe cannot discover its own required height.
  for (const assigned of [720, 720, 5000, 120]) {
    f.resizeViewport(900, assigned);
    f.flush();
    assert.equal(f.messages.at(-1)[0].height, 720);
  }
  assert.equal(f.messages.length, 2, 'assigned height echoes do not repeatedly grow or report');
  f.setHeight(140); // underlying form changed to confirmation before vendor return
  f.flush();
  assert.equal(f.messages.at(-1)[0].height, 720);
  f.resizeViewport(375, 720);
  f.flush();
  assert.equal(f.messages.at(-1)[0].height, 820);
  f.resizeViewport(900, 820);
  f.flush();
  assert.equal(f.messages.at(-1)[0].height, 720);
  f.setPaymentVisible(false);
  f.flush();
  assert.equal(f.messages.at(-1)[0].height, 140);
  for (const height of [1500, 240, 1500]) {
    f.setHeight(height);
    f.flush();
    assert.equal(f.messages.at(-1)[0].height, height);
  }
  assert.ok(f.messages.every(([message]) => message.type === 'iconn-form-resize'));
  runtime.dispose();
});

test('ordinary body menu mutations measure silently and coexist with payment reservation', () => {
  const f = fixture();
  const runtime = observeFormEmbedContent(f.root, f.win);
  f.flush();
  f.setHeight(240);
  f.flush();
  f.messages.length = 0;

  f.mutateBody();
  assert.equal(f.frames.size, 1, 'ordinary body mutation schedules one measurement');
  f.flush();
  assert.deepEqual(f.messages, [], 'unchanged menu layout emits neither resize nor navigation');

  f.setPaymentVisible(true);
  f.flush();
  assert.deepEqual(f.messages, [[{ type: 'iconn-form-resize', height: 720 }, '*']]);

  f.mutateBody();
  assert.equal(f.frames.size, 1, 'menu mutations continue to schedule with payment open');
  f.flush();
  assert.equal(f.messages.length, 1, 'stable payment reservation is not re-emitted');
  assert.ok(f.messages.every(([message]) => message.type !== FORM_PAGE_NAVIGATED_MESSAGE));
  runtime.dispose();
});

test('visible overlay preserves tall natural content but retry does not retain the old reservation', () => {
  const f = fixture();
  const runtime = observeFormEmbedContent(f.root, f.win);
  f.setPaymentVisible(true);
  f.flush();
  assert.equal(f.messages.at(-1)[0].height, 1200);
  f.setHeight(180);
  f.flush();
  assert.equal(f.messages.at(-1)[0].height, 1200);
  f.replacePayment();
  f.flush();
  assert.equal(f.messages.at(-1)[0].height, 720, 'replacement in the same animation frame has its own reservation');
  f.setPaymentVisible(false);
  f.flush();
  assert.equal(f.messages.at(-1)[0].height, 180);
  f.setPaymentVisible(true);
  f.flush();
  assert.equal(f.messages.at(-1)[0].height, 720);
  runtime.dispose();
  f.setPaymentVisible(false);
  f.resizeViewport(375, 820);
  f.flush();
  assert.equal(f.messages.at(-1)[0].height, 720, 'disposed observer cannot send stale reports');
});

test('payment reservation is document-local and disabled on standalone embed routes', () => {
  const first = fixture();
  const second = fixture();
  const runtimes = [first, second].map(f => observeFormEmbedContent(f.root, f.win));
  for (const f of [first, second]) { f.setHeight(200); f.flush(); }
  first.setPaymentVisible(true);
  first.flush();
  assert.equal(first.messages.at(-1)[0].height, 720);
  assert.equal(second.messages.at(-1)[0].height, 200);
  first.win.parent = first.win;
  first.win.postMessage = (...args) => first.messages.push(args);
  first.resizeViewport(375, 640);
  first.flush();
  assert.equal(first.messages.at(-1)[0].height, 200);
  runtimes.forEach(runtime => runtime.dispose());
  assert.equal(formEmbedPaymentViewportHeight(599), 820);
  assert.equal(formEmbedPaymentViewportHeight(600), 720);
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
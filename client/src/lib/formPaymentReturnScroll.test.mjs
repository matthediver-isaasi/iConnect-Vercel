import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  getPaymentReturnHeaderOffset,
  schedulePaymentReturnScroll,
  scrollPaymentReturnTarget,
} from './formPaymentReturnScroll.js';

function layout(element, rect) {
  element.getBoundingClientRect = () => ({ ...rect });
  Object.defineProperty(element, 'offsetHeight', {
    configurable: true,
    value: rect.height ?? (rect.bottom - rect.top),
  });
}

test('return scroll accounts for a visible sticky header and page offset', () => {
  const dom = new JSDOM(`
    <header class="sticky"></header>
    <main id="target"></main>
  `, { url: 'http://localhost/membership-return-canvas' });
  const { document } = dom.window;
  const header = document.querySelector('header');
  const target = document.querySelector('#target');
  layout(header, { top: 0, bottom: 72, height: 72 });
  layout(target, { top: 1300, bottom: 1600, height: 300 });
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2400 });

  const calls = [];
  const windowObj = {
    innerHeight: 800,
    pageYOffset: 100,
    scrollTo: (options) => calls.push(options),
  };

  assert.equal(getPaymentReturnHeaderOffset(document), 72);
  assert.equal(scrollPaymentReturnTarget(target, { windowObj, documentObj: document }), true);
  assert.deepEqual(calls, [{ top: 1312, behavior: 'auto' }]);
});

test('an already visible return target does not steal ordinary browsing scroll', () => {
  const dom = new JSDOM('<main id="target"></main>');
  const target = dom.window.document.querySelector('#target');
  layout(target, { top: 80, bottom: 260, height: 180 });
  const calls = [];
  const windowObj = {
    innerHeight: 800,
    pageYOffset: 420,
    scrollTo: (options) => calls.push(options),
  };

  assert.equal(scrollPaymentReturnTarget(target, { windowObj, documentObj: dom.window.document }), false);
  assert.deepEqual(calls, []);
});

test('return scroll clears sticky nav and data-marked Canvas chrome', () => {
  const dom = new JSDOM(`
    <nav></nav>
    <div data-canvas-sticky></div>
    <main id="target"></main>
  `);
  const { document } = dom.window;
  const nav = document.querySelector('nav');
  const canvasChrome = document.querySelector('[data-canvas-sticky]');
  const target = document.querySelector('#target');
  layout(nav, { top: 0, bottom: 48, height: 48 });
  layout(canvasChrome, { top: 48, bottom: 96, height: 48 });
  layout(target, { top: 1200, bottom: 1450, height: 250 });
  nav.style.position = 'sticky';
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2400 });
  const calls = [];
  const windowObj = {
    innerHeight: 800,
    pageYOffset: 0,
    scrollTo: options => calls.push(options),
  };

  assert.equal(getPaymentReturnHeaderOffset(document), 96);
  assert.equal(scrollPaymentReturnTarget(target, { windowObj, documentObj: document }), true);
  assert.deepEqual(calls, [{ top: 1088, behavior: 'auto' }]);
});

test('scheduled return scroll can be cancelled before delayed iframe layout settles', async () => {
  const dom = new JSDOM('<main id="target"></main>');
  const target = dom.window.document.querySelector('#target');
  layout(target, { top: 1200, bottom: 1450, height: 250 });
  const calls = [];
  const windowObj = {
    innerHeight: 800,
    pageYOffset: 0,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    scrollTo: (options) => calls.push(options),
  };
  const cleanup = schedulePaymentReturnScroll(target, {
    windowObj,
    documentObj: dom.window.document,
    delay: 20,
  });
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(calls, []);
});
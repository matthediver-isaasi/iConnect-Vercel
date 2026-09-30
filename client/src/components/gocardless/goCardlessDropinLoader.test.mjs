import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { subscribeGoCardlessDropin } from './goCardlessDropinLoader.js';

test('failure detaches both listeners, removes owned script, and permits retry', () => {
  const dom = new JSDOM('<!doctype html><head></head>', { url: 'https://example.test' });
  const removed = [];
  const originalRemove = dom.window.EventTarget.prototype.removeEventListener;
  dom.window.EventTarget.prototype.removeEventListener = function(type, listener, options) {
    if (this.tagName === 'SCRIPT') removed.push(type);
    return originalRemove.call(this, type, listener, options);
  };
  const errors = [];
  subscribeGoCardlessDropin({
    windowObj: dom.window,
    onLoad: () => assert.fail('failed script loaded'),
    onError: error => errors.push(error.message),
  });
  const failed = dom.window.document.querySelector('script');
  failed.dispatchEvent(new dom.window.Event('error'));
  assert.deepEqual(errors, ['Failed to load GoCardless Drop-in']);
  assert.deepEqual(removed.sort(), ['error', 'load']);
  assert.equal(failed.isConnected, false);

  let loaded = 0;
  subscribeGoCardlessDropin({
    windowObj: dom.window,
    onLoad: () => { loaded += 1; },
    onError: error => assert.fail(error.message),
  });
  const retry = dom.window.document.querySelector('script');
  assert.notEqual(retry, failed);
  dom.window.GoCardlessDropin = { create() {} };
  retry.dispatchEvent(new dom.window.Event('load'));
  retry.dispatchEvent(new dom.window.Event('error'));
  assert.equal(loaded, 1);
  dom.window.close();
});

test('last cancellation detaches listeners, removes hung owned script, and ignores late load', () => {
  const dom = new JSDOM('<!doctype html><head></head>', { url: 'https://example.test' });
  const calls = [];
  const cancel = subscribeGoCardlessDropin({
    windowObj: dom.window,
    onLoad: () => calls.push('load'),
    onError: () => calls.push('error'),
  });
  const script = dom.window.document.querySelector('script');
  cancel();
  cancel();
  assert.equal(script.isConnected, false);
  dom.window.GoCardlessDropin = { create() {} };
  script.dispatchEvent(new dom.window.Event('load'));
  script.dispatchEvent(new dom.window.Event('error'));
  assert.deepEqual(calls, []);
  dom.window.close();
});

test('shared load remains until its last subscriber cancels', () => {
  const dom = new JSDOM('<!doctype html><head></head>', { url: 'https://example.test' });
  const calls = [];
  const first = subscribeGoCardlessDropin({
    windowObj: dom.window,
    onLoad: () => calls.push('first'),
    onError: () => {},
  });
  const second = subscribeGoCardlessDropin({
    windowObj: dom.window,
    onLoad: () => calls.push('second'),
    onError: () => {},
  });
  const script = dom.window.document.querySelector('script');
  first();
  assert.equal(script.isConnected, true);
  dom.window.GoCardlessDropin = { create() {} };
  script.dispatchEvent(new dom.window.Event('load'));
  assert.deepEqual(calls, ['second']);
  second();
  dom.window.close();
});
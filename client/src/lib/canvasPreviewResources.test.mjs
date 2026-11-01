import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForCanvasPreviewResources } from './canvasPreviewResources.js';

class Image extends EventTarget {
  complete = false;
  loading = 'eager';
  listeners = 0;
  addEventListener(...args) { this.listeners++; super.addEventListener(...args); }
  removeEventListener(...args) { this.listeners--; super.removeEventListener(...args); }
}

test('offscreen lazy images do not delay readiness', async () => {
  const image = new Image();
  image.loading = 'lazy';
  await waitForCanvasPreviewResources({ images: [image] });
  assert.equal(image.listeners, 0);
});

for (const event of ['load', 'error']) {
  test(`eager images settle on ${event} and remove listeners`, async () => {
    const image = new Image();
    let settled = false;
    const wait = waitForCanvasPreviewResources({ images: [image] }).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    image.dispatchEvent(new Event(event));
    await wait;
    assert.equal(image.listeners, 0);
  });
}

test('stalled images and fonts share a bounded wait', async () => {
  const image = new Image();
  await waitForCanvasPreviewResources({
    images: [image], fonts: { ready: new Promise(() => {}) },
  }, { timeoutMs: 15 });
  assert.equal(image.listeners, 0);
});

test('fonts are awaited when they resolve within the budget', async () => {
  let resolveFonts;
  let settled = false;
  const ready = new Promise((resolve) => { resolveFonts = resolve; });
  const wait = waitForCanvasPreviewResources({ images: [], fonts: { ready } })
    .then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  resolveFonts();
  await wait;
  assert.equal(settled, true);
});

test('unmount or replacement cancels resource listeners', async () => {
  const image = new Image();
  const controller = new AbortController();
  const wait = waitForCanvasPreviewResources({ images: [image] }, { signal: controller.signal });
  controller.abort();
  await wait;
  assert.equal(image.listeners, 0);
});

test('complete images and rejected font loads settle immediately', async () => {
  const image = new Image();
  image.complete = true;
  await waitForCanvasPreviewResources({ images: [image], fonts: { ready: Promise.reject(new Error('font failed')) } });
  assert.equal(image.listeners, 0);
});

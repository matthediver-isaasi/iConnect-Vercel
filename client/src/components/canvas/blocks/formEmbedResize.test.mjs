import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { applyFormEmbedResize } from './formEmbedResize.js';

function defineLayout(el, { top, height }) {
  Object.defineProperty(el, 'offsetTop', {
    configurable: true,
    get: typeof top === 'function' ? top : () => top,
  });
  Object.defineProperty(el, 'offsetHeight', {
    configurable: true,
    get: typeof height === 'function' ? height : () => height,
  });
}

test('form resize ends the stage at the lowest block and fully restores styles', () => {
  const dom = new JSDOM(`
    <main class="canvas-stage" style="min-height: 420px">
      <div data-cb="form"></div>
      <section data-cb="final"></section>
    </main>
  `);
  const stage = dom.window.document.querySelector('.canvas-stage');
  const form = stage.querySelector('[data-cb="form"]');
  const final = stage.querySelector('[data-cb="final"]');

  let naturalFormHeight = 400;
  defineLayout(form, {
    top: 100,
    height: () => (form.style.height === 'auto' ? naturalFormHeight : 200),
  });
  defineLayout(final, {
    top: () => Number.parseFloat(final.style.top) || 320,
    height: 100,
  });

  const cleanupGrow = applyFormEmbedResize(form);
  assert.equal(final.style.top, '520px');
  assert.equal(stage.style.minHeight, '620px');
  assert.notEqual(stage.style.minHeight, '700px', 'published stage must not add an 80px buffer');

  cleanupGrow();
  assert.equal(form.style.height, '');
  assert.equal(form.style.overflow, '');
  assert.equal(final.style.top, '');
  assert.equal(stage.style.minHeight, '420px');

  naturalFormHeight = 300;
  const cleanupSmallerGrow = applyFormEmbedResize(form);
  assert.equal(final.style.top, '420px', 'a smaller later report must recompute from authored positions');
  assert.equal(stage.style.minHeight, '520px', 'stage must shrink to the new lowest rendered bottom');

  cleanupSmallerGrow();
  assert.equal(final.style.top, '');
  assert.equal(stage.style.minHeight, '420px');

  naturalFormHeight = 150;
  const cleanupBelowAuthored = applyFormEmbedResize(form);
  assert.equal(final.style.top, '', 'a form shorter than its authored box must not pull siblings upward');
  assert.equal(stage.style.minHeight, '420px', 'the unchanged final block remains the true stage bottom');

  cleanupBelowAuthored();
  assert.equal(final.style.top, '');
  assert.equal(stage.style.minHeight, '420px');
});
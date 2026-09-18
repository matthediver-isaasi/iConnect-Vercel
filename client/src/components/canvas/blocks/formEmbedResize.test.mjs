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

test('a form outside a Canvas stage still grows intrinsically and restores owned styles', () => {
  const dom = new JSDOM('<div data-cb="flow-form" style="height: 240px; overflow: hidden"></div>');
  const form = dom.window.document.querySelector('[data-cb="flow-form"]');

  const cleanup = applyFormEmbedResize(form);
  assert.equal(form.style.height, 'auto');
  assert.equal(form.style.overflow, 'visible');

  cleanup();
  assert.equal(form.style.height, '240px');
  assert.equal(form.style.overflow, 'hidden');
  cleanup();
  assert.equal(form.style.height, '240px', 'cleanup remains idempotent');
});

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

test('multiple forms coordinate growth and independent cleanup from authored geometry', () => {
  const dom = new JSDOM(`
    <main class="canvas-stage" style="min-height: 700px">
      <div data-cb="first"></div>
      <div data-cb="second"></div>
      <section data-cb="final"></section>
    </main>
  `);
  const stage = dom.window.document.querySelector('.canvas-stage');
  const first = stage.querySelector('[data-cb="first"]');
  const second = stage.querySelector('[data-cb="second"]');
  const final = stage.querySelector('[data-cb="final"]');
  let firstNaturalHeight = 300;
  let secondNaturalHeight = 350;

  defineLayout(first, {
    top: () => Number.parseFloat(first.style.top) || 100,
    height: () => (first.style.height === 'auto' ? firstNaturalHeight : 200),
  });
  defineLayout(second, {
    top: () => Number.parseFloat(second.style.top) || 350,
    height: () => (second.style.height === 'auto' ? secondNaturalHeight : 200),
  });
  defineLayout(final, {
    top: () => Number.parseFloat(final.style.top) || 600,
    height: 100,
  });

  const cleanupFirst = applyFormEmbedResize(first);
  assert.equal(second.style.top, '450px');
  assert.equal(final.style.top, '700px');

  const cleanupSecond = applyFormEmbedResize(second);
  assert.equal(second.style.top, '450px', 'the second form keeps the first form growth above it');
  assert.equal(final.style.top, '850px', 'content below both forms receives both growth deltas');
  assert.equal(stage.style.minHeight, '950px');

  cleanupFirst();
  assert.equal(second.style.top, '', 'removing the first form restores authored spacing above the second');
  assert.equal(final.style.top, '750px', 'the remaining form growth is recomputed rather than undone');
  assert.equal(stage.style.minHeight, '850px');

  cleanupSecond();
  assert.equal(first.style.height, '');
  assert.equal(second.style.height, '');
  assert.equal(final.style.top, '');
  assert.equal(stage.style.minHeight, '700px');
});

test('coordinator does not overwrite unrelated inline height updates', () => {
  const dom = new JSDOM(`
    <main class="canvas-stage" style="min-height: 420px">
      <div data-cb="form"></div>
      <section data-cb="accordion" style="height: 100px"></section>
    </main>
  `);
  const stage = dom.window.document.querySelector('.canvas-stage');
  const form = stage.querySelector('[data-cb="form"]');
  const accordion = stage.querySelector('[data-cb="accordion"]');
  defineLayout(form, {
    top: 100,
    height: () => (form.style.height === 'auto' ? 400 : 200),
  });
  defineLayout(accordion, {
    top: () => Number.parseFloat(accordion.style.top) || 320,
    height: () => Number.parseFloat(accordion.style.height),
  });

  const cleanup = applyFormEmbedResize(form);
  assert.equal(accordion.style.top, '520px');
  accordion.style.height = '180px';

  cleanup();
  assert.equal(accordion.style.height, '180px', 'form cleanup must not own accordion/container height');
  assert.equal(accordion.style.top, '');
  assert.equal(stage.style.minHeight, '420px');
});


test('a repeated form shrink preserves another active form and refreshes breakpoint geometry', () => {
  const dom = new JSDOM(`
    <main class="canvas-stage" style="min-height: 700px">
      <div data-cb="first"></div>
      <div data-cb="second"></div>
      <section data-cb="final"></section>
    </main>
  `);
  const stage = dom.window.document.querySelector('.canvas-stage');
  const first = stage.querySelector('[data-cb="first"]');
  const second = stage.querySelector('[data-cb="second"]');
  const final = stage.querySelector('[data-cb="final"]');
  let breakpoint = 'desktop';
  let firstNaturalHeight = 300;
  let secondNaturalHeight = 350;
  const authored = {
    desktop: { first: [100, 200], second: [350, 200], final: [600, 100] },
    mobile: { first: [40, 160], second: [240, 160], final: [440, 80] },
  };
  const metric = (name, index, element) => () => (
    element.style.top && index === 0
      ? Number.parseFloat(element.style.top)
      : authored[breakpoint][name][index]
  );

  defineLayout(first, {
    top: metric('first', 0, first),
    height: () => (first.style.height === 'auto' ? firstNaturalHeight : authored[breakpoint].first[1]),
  });
  defineLayout(second, {
    top: metric('second', 0, second),
    height: () => (second.style.height === 'auto' ? secondNaturalHeight : authored[breakpoint].second[1]),
  });
  defineLayout(final, {
    top: metric('final', 0, final),
    height: () => authored[breakpoint].final[1],
  });

  let cleanupFirst = applyFormEmbedResize(first);
  const cleanupSecond = applyFormEmbedResize(second);
  assert.equal(final.style.top, '850px');

  cleanupFirst();
  firstNaturalHeight = 220;
  cleanupFirst = applyFormEmbedResize(first);
  assert.equal(final.style.top, '770px', 'the smaller repeat report replaces, rather than accumulates, growth');

  cleanupFirst();
  firstNaturalHeight = 150;
  cleanupFirst = applyFormEmbedResize(first);
  assert.equal(final.style.top, '750px', 'shrinking below authored height does not pull later content upward');

  breakpoint = 'mobile';
  cleanupFirst();
  firstNaturalHeight = 200;
  cleanupFirst = applyFormEmbedResize(first);
  assert.equal(second.style.top, '280px', 'restored styles allow current breakpoint geometry to be measured');
  assert.equal(final.style.top, '670px', 'both active forms are reapplied to mobile authored positions');
  assert.equal(stage.style.minHeight, '750px');

  cleanupSecond();
  assert.equal(final.style.top, '480px', 'cleaning one form leaves only the other mobile growth');
  cleanupFirst();
  assert.equal(second.style.top, '');
  assert.equal(final.style.top, '');
  assert.equal(stage.style.minHeight, '700px');
});
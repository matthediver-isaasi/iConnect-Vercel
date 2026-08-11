// Task #3515: behavioral coverage of useCardSwipeAutoFocus in a real React
// tree (jsdom + react-dom/client + act). The pure decision + wiring contracts
// live in ./cardSwipeAutoFocus.test.mjs; these tests mount a miniature
// card-swipe harness (input keyed by step, autoFocus from the hook — the same
// shape as the real render paths) and assert on document.activeElement:
//  1. initial mount never focuses (no scroll-to-form on page load),
//  2. the FIRST committed step transition focuses (same render, no lag),
//  3. returning to the mount step afterwards still focuses (committed latch).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

before(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.navigator = window.navigator;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

const React = (await import('react')).default;
const { createElement: h, useState, act } = React;
const { createRoot } = await import('react-dom/client');
const { useCardSwipeAutoFocus } = await import('./cardSwipeAutoFocus.js');

// Miniature card-swipe: one input per step, remounted via key={step} with
// autoFocus from the hook — exactly how the three real surfaces wire it.
let setStepExternal;
function Harness() {
  const [step, setStep] = useState(0);
  setStepExternal = setStep;
  const autoFocusFor = useCardSwipeAutoFocus(step);
  return h('input', {
    key: step,
    'data-step': step,
    autoFocus: autoFocusFor('text'),
  });
}

test('mount → no focus; first transition → focus; back to first card → focus', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  // 1. Initial mount: the input must NOT be focused (this focus is what
  //    scrolled embedding pages down to the form on load).
  await act(async () => { root.render(h(Harness)); });
  const input0 = container.querySelector('input');
  assert.equal(input0.dataset.step, '0');
  assert.notEqual(document.activeElement, input0, 'initial mount must not autofocus');

  // 2. First committed transition: the remounted input focuses in the SAME
  //    commit (no one-render lag).
  await act(async () => { setStepExternal(1); });
  const input1 = container.querySelector('input');
  assert.equal(input1.dataset.step, '1');
  assert.equal(document.activeElement, input1, 'step transition must autofocus');

  // 3. Back to the mount step: committed latch keeps focusing.
  await act(async () => { setStepExternal(0); });
  const inputBack = container.querySelector('input');
  assert.equal(inputBack.dataset.step, '0');
  assert.equal(document.activeElement, inputBack, 'returning to the first card must still autofocus');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('non-typeable field types never focus, even after navigation', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  let setStep2;
  function SelectHarness() {
    const [step, setStep] = useState(0);
    setStep2 = setStep;
    const autoFocusFor = useCardSwipeAutoFocus(step);
    return h('input', { key: step, autoFocus: autoFocusFor('boolean') });
  }

  await act(async () => { root.render(h(SelectHarness)); });
  await act(async () => { setStep2(1); });
  const input = container.querySelector('input');
  assert.notEqual(document.activeElement, input, 'non-typeable types never autofocus');

  await act(async () => { root.unmount(); });
  container.remove();
});

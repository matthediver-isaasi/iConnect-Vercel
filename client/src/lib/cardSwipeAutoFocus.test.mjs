// Task #3515: card-swipe autofocus gating — no scroll-triggering focus on
// initial load, focus preserved on step transitions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { shouldAutoFocusCardField, CARD_SWIPE_AUTOFOCUS_TYPES } from './cardSwipeAutoFocus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), 'utf8');

// --- pure decision -----------------------------------------------------------

test('never autofocus before the user has navigated between cards', () => {
  for (const type of CARD_SWIPE_AUTOFOCUS_TYPES) {
    assert.equal(shouldAutoFocusCardField({ fieldType: type, hasNavigated: false }), false);
  }
});

test('autofocus typeable fields after a card transition', () => {
  for (const type of CARD_SWIPE_AUTOFOCUS_TYPES) {
    assert.equal(shouldAutoFocusCardField({ fieldType: type, hasNavigated: true }), true);
  }
});

test('non-typeable field types never autofocus', () => {
  for (const type of ['select', 'boolean', 'file', 'instructions', 'image', undefined, null]) {
    assert.equal(shouldAutoFocusCardField({ fieldType: type, hasNavigated: true }), false);
  }
});

test('type list unchanged from the legacy inline list', () => {
  assert.deepEqual(CARD_SWIPE_AUTOFOCUS_TYPES, ['text', 'email', 'url', 'number', 'tel', 'textarea']);
});

// --- hook latch behaviour (simulated) ----------------------------------------
// The hook latches hasNavigated once currentStep differs from the mount step;
// returning to the first card afterwards still focuses. Simulated here via
// the same ref semantics; the source contract below pins the implementation.

test('latch semantics: back to first card after navigating still focuses', () => {
  // mount at step 0 -> no focus; step 1 -> focus; back to step 0 -> focus.
  let initial = 0; let navigated = false;
  const visit = (step) => {
    if (step !== initial) navigated = true;
    return shouldAutoFocusCardField({ fieldType: 'text', hasNavigated: navigated });
  };
  assert.equal(visit(0), false);
  assert.equal(visit(1), true);
  assert.equal(visit(0), true);
});

// --- wiring contracts ---------------------------------------------------------

const CARD_SWIPE_SURFACES = [
  '../components/iedit/elements/IEditFormElement.jsx',
  '../pages/FormView.jsx',
  '../pages/EmbedForm.jsx',
];

test('all three card-swipe render paths use the shared gated autofocus', () => {
  for (const surface of CARD_SWIPE_SURFACES) {
    const src = read(surface);
    assert.match(src, /useCardSwipeAutoFocus\(currentStep\)/, `${surface} must mount the gate hook`);
    assert.match(src, /autoFocus=\{cardSwipeAutoFocusFor\(/, `${surface} must pass the gated value to FormRenderer`);
    assert.doesNotMatch(
      src,
      /autoFocus=\{\['text'/,
      `${surface} must not keep the ungated inline type-list autofocus`,
    );
  }
});

test('the hook implements the latch on refs (no focus on initial mount)', () => {
  const src = read('./cardSwipeAutoFocus.js');
  assert.match(src, /initialStepRef/);
  assert.match(src, /navigatedRef/);
  assert.match(src, /currentStep !== initialStepRef.current/);
});

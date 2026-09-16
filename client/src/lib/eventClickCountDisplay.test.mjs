import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveEventClickCountDisplay } from './eventClickCountDisplay.js';

test('shows resolved zero and non-zero click totals', () => {
  assert.deepEqual(resolveEventClickCountDisplay({ count: 0 }), {
    kind: 'ready',
    text: '0',
    ariaLabel: 'Event clicks: 0',
  });
  assert.deepEqual(resolveEventClickCountDisplay({ count: 12 }), {
    kind: 'ready',
    text: '12',
    ariaLabel: 'Event clicks: 12',
  });
});

test('keeps loading and error states distinct from zero', () => {
  assert.equal(resolveEventClickCountDisplay({ isLoading: true }).kind, 'loading');
  assert.equal(resolveEventClickCountDisplay({ isError: true }).kind, 'unavailable');
  assert.equal(resolveEventClickCountDisplay().kind, 'unavailable');
});
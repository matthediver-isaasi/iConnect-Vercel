import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedSessionLookup } from './sessionAvailability.js';

test('a hung lookup fails closed within its budget', async () => {
  await assert.rejects(
    boundedSessionLookup(() => new Promise(() => {}), 5),
    error => error.status === 503 && error.code === 'SESSION_UNAVAILABLE',
  );
  assert.equal(await boundedSessionLookup(() => null), null);
});

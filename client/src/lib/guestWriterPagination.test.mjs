import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getGuestWriterPageCount,
  getGuestWriterRange,
  normalizeGuestWriterPage,
} from './guestWriterPagination.js';

test('normalizes the exact-count entity response', () => {
  const rows = [{ id: 'writer-1', full_name: 'Ada Writer' }];
  assert.deepEqual(normalizeGuestWriterPage({ data: rows, count: 25 }), {
    data: rows,
    count: 25,
  });
});

test('rejects bare arrays and invalid counts instead of silently losing pagination', () => {
  assert.throws(() => normalizeGuestWriterPage([]), /invalid paginated response/);
  assert.throws(
    () => normalizeGuestWriterPage({ data: [], count: -1 }),
    /invalid paginated response/,
  );
});

test('derives bounded page counts and display ranges', () => {
  assert.equal(getGuestWriterPageCount(0, 12), 1);
  assert.equal(getGuestWriterPageCount(25, 12), 3);
  assert.deepEqual(getGuestWriterRange(1, 12, 0), { start: 0, end: 0 });
  assert.deepEqual(getGuestWriterRange(3, 12, 25), { start: 25, end: 25 });
});
// Time-bucket rolling window: resolveTimeWindowStart + finalizeTimeRows.
// The window limits chart buckets to the last X periods relative to "now"
// (UTC, aligned to the start of the unit period) and zero-fills empty
// buckets inside the window so the axis shows a continuous run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTimeWindowStart, finalizeTimeRows } from './aggregation.js';

const NOW = new Date('2026-08-11T14:30:00.000Z'); // a Tuesday

test('resolveTimeWindowStart returns null for absent/invalid windows', () => {
  assert.equal(resolveTimeWindowStart(null, NOW), null);
  assert.equal(resolveTimeWindowStart(undefined, NOW), null);
  assert.equal(resolveTimeWindowStart({}, NOW), null);
  assert.equal(resolveTimeWindowStart({ amount: 0, unit: 'month' }, NOW), null);
  assert.equal(resolveTimeWindowStart({ amount: -3, unit: 'month' }, NOW), null);
  assert.equal(resolveTimeWindowStart({ amount: 'x', unit: 'month' }, NOW), null);
  assert.equal(resolveTimeWindowStart({ amount: 3, unit: 'fortnight' }, NOW), null);
});

test('window start aligns to the start of the unit period (UTC)', () => {
  // Last 12 months from Aug 2026 -> Sep 1 2025 (current month counts).
  assert.equal(
    resolveTimeWindowStart({ amount: 12, unit: 'month' }, NOW).toISOString(),
    '2025-09-01T00:00:00.000Z',
  );
  // Last 1 month -> start of the current month.
  assert.equal(
    resolveTimeWindowStart({ amount: 1, unit: 'month' }, NOW).toISOString(),
    '2026-08-01T00:00:00.000Z',
  );
  // Last 7 days -> midnight 6 days ago.
  assert.equal(
    resolveTimeWindowStart({ amount: 7, unit: 'day' }, NOW).toISOString(),
    '2026-08-05T00:00:00.000Z',
  );
  // Last 2 weeks -> Monday of last week (weeks start Monday, like buckets).
  assert.equal(
    resolveTimeWindowStart({ amount: 2, unit: 'week' }, NOW).toISOString(),
    '2026-08-03T00:00:00.000Z',
  );
  // Last 2 quarters -> start of Q2 2026.
  assert.equal(
    resolveTimeWindowStart({ amount: 2, unit: 'quarter' }, NOW).toISOString(),
    '2026-04-01T00:00:00.000Z',
  );
  // Last 3 years -> Jan 1 2024.
  assert.equal(
    resolveTimeWindowStart({ amount: 3, unit: 'year' }, NOW).toISOString(),
    '2024-01-01T00:00:00.000Z',
  );
});

test('no window keeps legacy behaviour: populated buckets only, sorted', () => {
  const buckets = new Map([
    ['2026-03', [1, 1]],
    ['2020-01', [1]],
    ['2026-08', [1, 1, 1]],
  ]);
  const rows = finalizeTimeRows(buckets, { granularity: 'month' }, 'count', false, NOW);
  assert.deepEqual(rows, [
    { key: '2020-01', value: 1 },
    { key: '2026-03', value: 2 },
    { key: '2026-08', value: 3 },
  ]);
});

test('window drops out-of-range buckets and zero-fills empty ones', () => {
  const buckets = new Map([
    ['2020-01', [1, 1, 1]], // outside the window — dropped
    ['2026-04', [1]],
    ['2026-08', [1, 1]],
  ]);
  const tb = { granularity: 'month', window: { amount: 6, unit: 'month' } };
  const rows = finalizeTimeRows(buckets, tb, 'count', false, NOW);
  assert.deepEqual(rows, [
    { key: '2026-03', value: 0 },
    { key: '2026-04', value: 1 },
    { key: '2026-05', value: 0 },
    { key: '2026-06', value: 0 },
    { key: '2026-07', value: 0 },
    { key: '2026-08', value: 2 },
  ]);
});

test('window unit can differ from the bucket granularity', () => {
  // Last 1 year, bucketed by quarter -> Q1..Q3 2026.
  const buckets = new Map([['2026-Q2', [1]]]);
  const tb = { granularity: 'quarter', window: { amount: 1, unit: 'year' } };
  const rows = finalizeTimeRows(buckets, tb, 'count', false, NOW);
  assert.deepEqual(rows.map(r => r.key), ['2026-Q1', '2026-Q2', '2026-Q3']);
  assert.deepEqual(rows.map(r => r.value), [0, 1, 0]);
});

test('windowed weeks enumerate Mondays', () => {
  const tb = { granularity: 'week', window: { amount: 3, unit: 'week' } };
  const rows = finalizeTimeRows(new Map(), tb, 'count', false, NOW);
  assert.deepEqual(rows.map(r => r.key), ['2026-07-27', '2026-08-03', '2026-08-10']);
});

test('cumulative applies within the window only', () => {
  const buckets = new Map([
    ['2019-01', [1, 1]], // outside window — must not seed the running total
    ['2026-07', [1]],
    ['2026-08', [1, 1]],
  ]);
  const tb = { granularity: 'month', window: { amount: 3, unit: 'month' } };
  const rows = finalizeTimeRows(buckets, tb, 'count', true, NOW);
  assert.deepEqual(rows, [
    { key: '2026-06', value: 0 },
    { key: '2026-07', value: 1 },
    { key: '2026-08', value: 3 },
  ]);
});

test('windows exceeding the bucket cap are rejected', () => {
  const tb = { granularity: 'day', window: { amount: 5, unit: 'year' } };
  assert.throws(
    () => finalizeTimeRows(new Map(), tb, 'count', false, NOW),
    /max 50/,
  );
});

test('sum over an empty window bucket is zero', () => {
  const buckets = new Map([['2026-08', [5, 2.5]]]);
  const tb = { granularity: 'month', window: { amount: 2, unit: 'month' } };
  const rows = finalizeTimeRows(buckets, tb, 'sum', false, NOW);
  assert.deepEqual(rows, [
    { key: '2026-07', value: 0 },
    { key: '2026-08', value: 7.5 },
  ]);
});

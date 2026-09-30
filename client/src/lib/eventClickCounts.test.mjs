import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchEventClickCounts, normalizeEventClickCounts } from './eventClickCounts.js';

test('normalizes typed click counts while preserving zero', () => {
  assert.deepEqual(
    normalizeEventClickCounts({
      simple: { one: 0, two: '4', invalid: -1, bad: 'nope' },
      complex: { three: 9 },
    }),
    { simple: { one: 0, two: 4 }, complex: { three: 9 } },
  );
});

test('posts both event types to the secured admin count contract', async () => {
  const calls = [];
  const counts = await fetchEventClickCounts({
    simpleEventIds: ['simple-1', 'simple-1'],
    complexEventIds: ['complex-1'],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ counts: { simple: { 'simple-1': 0 }, complex: { 'complex-1': 3 } } }),
      };
    },
  });
  assert.equal(calls[0].url, '/api/admin/events/click-counts');
  assert.equal(calls[0].options.credentials, 'include');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    simpleEventIds: ['simple-1'],
    complexEventIds: ['complex-1'],
  });
  assert.deepEqual(counts, { simple: { 'simple-1': 0 }, complex: { 'complex-1': 3 } });
});

test('rejects a failed count response', async () => {
  await assert.rejects(
    fetchEventClickCounts({
      simpleEventIds: ['simple-1'],
      fetchImpl: async () => ({ ok: false }),
    }),
    /Failed to load event click counts/,
  );
});

test('batches more than 500 typed ids while keeping same ids isolated by type', async () => {
  const simpleEventIds = Array.from({ length: 500 }, (_, index) => `event-${index}`);
  const complexEventIds = ['event-0', 'complex-501'];
  const calls = [];

  const counts = await fetchEventClickCounts({
    simpleEventIds,
    complexEventIds,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          counts: {
            simple: Object.fromEntries(body.simpleEventIds.map((id) => [id, 2])),
            complex: Object.fromEntries(body.complexEventIds.map((id) => [id, 7])),
          },
        }),
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(
    calls.every(({ body }) => body.simpleEventIds.length + body.complexEventIds.length <= 500),
    true,
  );
  assert.deepEqual(calls[0].body, {
    simpleEventIds,
    complexEventIds: [],
  });
  assert.deepEqual(calls[1].body, {
    simpleEventIds: [],
    complexEventIds,
  });
  assert.equal(counts.simple['event-0'], 2);
  assert.equal(counts.complex['event-0'], 7);
  assert.equal(counts.complex['complex-501'], 7);
});

test('does not return partial or false-zero counts when a batch fails', async () => {
  const simpleEventIds = Array.from({ length: 500 }, (_, index) => `event-${index}`);
  const complexEventIds = ['complex-500'];
  let requestIndex = 0;

  await assert.rejects(
    fetchEventClickCounts({
      simpleEventIds,
      complexEventIds,
      fetchImpl: async () => {
        requestIndex += 1;
        if (requestIndex === 1) {
          return {
            ok: true,
            json: async () => ({ counts: { simple: { 'event-0': 0 }, complex: {} } }),
          };
        }
        return { ok: false };
      },
    }),
    /Failed to load event click counts/,
  );
  assert.equal(requestIndex, 2);
});
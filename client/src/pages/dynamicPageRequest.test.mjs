import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublicPage, DYNAMIC_PAGE_PENDING_TIMEOUT_MS } from './dynamicPageRequest.js';

test('a successful early public request preserves its payload', async () => {
  const payload = { page: { id: 'published-page' }, elements: [] };
  assert.deepEqual(await readPublicPage(async () => payload), { data: payload });
});

test('only the explicit public page miss contract permits protected-page fallback', async () => {
  assert.deepEqual(await readPublicPage(async () => {
    throw Object.assign(new Error('Missing'), {
      status: 404, errorData: { error: 'Page not found or not published' },
    });
  }), { data: null });
});

test('tenant, microsite, unstructured 404s and cancellation fail closed', async () => {
  for (const errorData of [undefined, { error: 'Tenant not found' }, { error: 'Microsite not found' }]) {
    const failure = Object.assign(new Error('Missing'), { status: 404, errorData });
    await assert.rejects(readPublicPage(async () => { throw failure; }), error => error === failure);
  }
  const aborted = Object.assign(new Error('Cancelled'), { name: 'AbortError' });
  await assert.rejects(readPublicPage(async () => { throw aborted; }), error => error === aborted);
});

test('failed transport, server errors and access denial remain failures', async () => {
  for (const status of [undefined, 400, 401, 403, 429, 500, 503]) {
    const failure = Object.assign(new Error('Request failed'), { status });
    await assert.rejects(readPublicPage(async () => { throw failure; }), error => error === failure);
  }
});

test('pending deadline is bounded without treating a slow response as a miss', async () => {
  assert.ok(DYNAMIC_PAGE_PENDING_TIMEOUT_MS > 0 && DYNAMIC_PAGE_PENDING_TIMEOUT_MS <= 30_000);
  let resolve;
  const pending = readPublicPage(() => new Promise(done => { resolve = done; }));
  let settled = false;
  pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  resolve({ page: { id: 'late-page' } });
  assert.deepEqual(await pending, { data: { page: { id: 'late-page' } } });
});
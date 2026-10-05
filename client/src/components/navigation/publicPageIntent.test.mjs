import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicPageIntentPool } from './publicPageIntent.js';

const request = (slug = 'b', prefix = null) => ({ slug, micrositePrefix: prefix });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('hover/focus and repeated clicks adopt one in-flight request, never a completed speculative response', async () => {
  const reads = [];
  const pool = createPublicPageIntentPool((target, signal) => {
    const gate = deferred();
    reads.push({ target, signal, gate });
    return gate.promise;
  });
  const intent = pool.acquire('tenant-a/guest', request());
  assert.equal(pool.acquire('tenant-a/guest', request()), intent, 'hover and focus are idempotent');
  assert.equal(pool.acquire('tenant-a/guest', request(), true), intent, 'click adopts transport');
  assert.equal(pool.acquire('tenant-a/guest', request(), true), intent, 'repeated activation stays idempotent');
  assert.equal(reads.length, 1);
  reads[0].gate.resolve({ data: { page: { id: 'b' } } });
  await intent.settled;
  assert.equal(intent.result.data.page.id, 'b');
  pool.clear();
  assert.equal(intent.result, undefined);
  const speculative = pool.acquire('tenant-a/guest', request());
  reads[1].gate.resolve({ data: { page: { id: 'not-retained' } } });
  await speculative.settled;
  assert.equal(speculative.result, undefined);
  const fresh = pool.acquire('tenant-a/guest', request(), true);
  assert.notEqual(fresh, speculative);
  assert.equal(reads.length, 3);
  reads[2].gate.resolve({ data: null });
  await fresh.settled;
  pool.clear();
});

test('tenant, audience, and prefix changes abort old intent and cannot adopt its late payload', async () => {
  for (const [nextScope, nextRequest] of [
    ['tenant-b/guest', request()], ['tenant-a/member', request()], ['tenant-a/guest', request('b', 'branch')],
  ]) {
    const gates = [];
    const pool = createPublicPageIntentPool((target, signal) => {
      const gate = deferred();
      gates.push({ gate, signal, target });
      return gate.promise;
    });
    const previous = pool.acquire('tenant-a/guest', request());
    const next = pool.acquire(nextScope, nextRequest, true);
    assert.notEqual(next, previous);
    assert.equal(gates[0].signal.aborted, true);
    gates[0].gate.resolve({ data: { page: { id: 'old-member' } } });
    await previous.settled;
    assert.equal(previous.result, undefined);
    gates[1].gate.resolve({ data: { page: { id: 'current' } } });
    await next.settled;
    assert.equal(next.result.data.page.id, 'current');
    pool.clear();
  }
});

test('rapid targets never exceed two actual transports and only the latest queued target starts', async () => {
  const reads = [];
  let active = 0;
  let maximum = 0;
  const pool = createPublicPageIntentPool((target, signal) => {
    const gate = deferred();
    reads.push({ target, signal, gate });
    active += 1;
    maximum = Math.max(maximum, active);
    // Model transport abort acknowledgement delayed until settlement.
    return gate.promise.finally(() => { active -= 1; });
  });
  const first = pool.acquire('guest', request('a'));
  const second = pool.acquire('guest', request('b'));
  const superseded = pool.acquire('guest', request('c'));
  const last = pool.acquire('guest', request('d'), true);
  assert.equal(reads.length, 2);
  assert.equal(reads[0].signal.aborted, true);
  assert.equal(reads[1].signal.aborted, true);
  await superseded.settled;
  reads[0].gate.resolve({ data: null });
  await first.settled;
  await Promise.resolve();
  assert.deepEqual(reads.map(item => item.target.slug), ['a', 'b', 'd']);
  reads[1].gate.resolve({ data: null });
  reads[2].gate.resolve({ data: null });
  await Promise.all([second.settled, last.settled]);
  assert.equal(maximum, 2);
  pool.clear();
});

test('unactivated intent expires and rejected speculation is handled without automatic navigation', async () => {
  const pool = createPublicPageIntentPool((target, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Expired', 'AbortError')), { once: true });
  }), { lifetimeMs: 8 });
  const task = pool.acquire('guest', request());
  await task.settled;
  assert.equal(task.controller.signal.aborted, true);
  assert.equal(task.result, undefined);
  await assert.rejects(task.promise, { name: 'AbortError' });
  const failedPool = createPublicPageIntentPool(async () => { throw new Error('Network unavailable'); });
  const failed = failedPool.acquire('guest', request());
  await failed.settled;
  assert.equal(failed.result, undefined);
  const clicked = failedPool.acquire('guest', request(), true);
  await clicked.settled;
  await assert.rejects(clicked.promise, /Network unavailable/);
  failedPool.clear();
  pool.clear();
  const gates = [];
  const delayedAbortPool = createPublicPageIntentPool(() => {
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  }, { lifetimeMs: 8 });
  const expired = delayedAbortPool.acquire('guest', request());
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(expired.controller.signal.aborted, true);
  const fresh = delayedAbortPool.acquire('guest', request(), true);
  assert.notEqual(fresh, expired, 'a transport awaiting expiry acknowledgement cannot be adopted');
  gates[0].resolve({ data: { page: { id: 'expired' } } });
  gates[1].resolve({ data: { page: { id: 'fresh' } } });
  await Promise.all([expired.settled, fresh.settled]);
  assert.equal(expired.result, undefined);
  assert.equal(fresh.result.data.page.id, 'fresh');
  delayedAbortPool.clear();
});

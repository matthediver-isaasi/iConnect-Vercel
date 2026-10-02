import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { VIEWER_SESSION_REVALIDATE_MS } from './viewerSessionPreload.js';
import {
  resolveRoutineSessionRole,
  recoverViewerSession,
  mayStartViewerSessionRecovery,
  viewerSessionCanRecover,
  useViewerSessionRevalidation,
} from './viewerSessionLifecycle.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

test('timer, focus, and visibility share one routine check and re-arm after success', async () => {
  const originalNow = Date.now;
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  let now = 10_000;
  let visibility = 'visible';
  const timers = new Map();
  let timerId = 0;
  Date.now = () => now;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  window.setTimeout = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  window.clearTimeout = id => timers.delete(id);

  let checks = 0;
  const onRevalidate = () => { checks += 1; };
  function Harness({ validatedAt }) {
    useViewerSessionRevalidation({ enabled: true, validatedAt, onRevalidate });
    return <input defaultValue="unsaved" />;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness validatedAt={now} />));
    const input = container.querySelector('input');
    input.value = 'still here';
    const first = [...timers.values()][0];
    assert.equal(first.delay, VIEWER_SESSION_REVALIDATE_MS);
    now += VIEWER_SESSION_REVALIDATE_MS;
    await act(async () => {
      first.callback();
      window.dispatchEvent(new window.Event('focus'));
      document.dispatchEvent(new window.Event('visibilitychange'));
    });
    assert.equal(checks, 1, 'concurrent overdue events start only one check');
    assert.equal(container.querySelector('input'), input);
    assert.equal(input.value, 'still here');

    await act(async () => root.render(<Harness validatedAt={now} />));
    now += VIEWER_SESSION_REVALIDATE_MS;
    await act(async () => [...timers.values()].at(-1).callback());
    assert.equal(checks, 2, 'a successful epoch schedules the next bounded check');
  } finally {
    await act(async () => root.unmount());
    Date.now = originalNow;
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
  }
});

test('transient recovery uses fresh attempts, small backoffs, and the original retention deadline', async () => {
  let now = 100;
  let attempts = 0;
  let blocked = 0;
  const sleeps = [];
  const result = await recoverViewerSession({
    request: async () => {
      attempts += 1;
      const error = new Error('Unavailable');
      error.status = 503;
      throw error;
    },
    isCurrent: () => true,
    isAvailable: () => true,
    retentionDeadline: 10_100,
    now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; },
    onDeadline: () => { blocked += 1; },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [500, 1000, 8500]);
  assert.equal(now, 10_100);
  assert.equal(blocked, 1);
  assert.equal(result.authoritative, undefined);
});

test('a retry never extends an expired retention window and success may restore it', async () => {
  let now = 15_000;
  let attempts = 0;
  let blocked = 0;
  const result = await recoverViewerSession({
    request: async () => {
      if (++attempts === 1) throw new TypeError('Failed to fetch');
      return { member: { id: 'same' } };
    },
    isCurrent: () => true,
    isAvailable: () => true,
    retentionDeadline: 10_000,
    now: () => now,
    sleep: async ms => { now += ms; },
    onDeadline: () => { blocked += 1; },
  });
  assert.equal(result.value.member.id, 'same');
  assert.equal(attempts, 2);
  assert.ok(blocked >= 1);
  assert.equal(now, 15_500);
});

test('authoritative role failures terminate immediately without backoff', async () => {
  let attempts = 0;
  const result = await recoverViewerSession({
    request: async () => {
      attempts += 1;
      await resolveRoutineSessionRole(
        { id: 'm', tenant_id: 't', role_id: 'r' },
        async () => ({ id: 'foreign', tenant_id: 't' }), 100,
      );
    },
    isCurrent: () => true,
    isAvailable: () => true,
    retentionDeadline: Date.now() + 10_000,
    sleep: async () => assert.fail('authoritative errors must not retry'),
  });
  assert.equal(attempts, 1);
  assert.equal(result.authoritative, true);
});

test('expired wall clock skips queued retries regardless of timer burst ordering', async () => {
  let now = 1;
  let attempts = 0;
  let blocked = false;
  await recoverViewerSession({
    request: async () => { attempts += 1; throw new Error('offline'); },
    isCurrent: () => true,
    isAvailable: () => true,
    retentionDeadline: 10_001,
    now: () => now,
    sleep: async () => { now = 20_000; },
    onDeadline: () => { blocked = true; },
  });
  assert.equal(attempts, 1);
  assert.equal(blocked, true);
});

test('timed-out attempts and cancelled generations fence late responses', async () => {
  let firstFence;
  let finishFirst;
  let attempts = 0;
  let now = 1;
  const result = await recoverViewerSession({
    request: fence => {
      if (++attempts === 1) {
        firstFence = fence;
        return new Promise(resolve => { finishFirst = resolve; });
      }
      return Promise.resolve('fresh');
    },
    isCurrent: () => true,
    isAvailable: () => true,
    retentionDeadline: 10_001,
    now: () => now,
    sleep: async ms => { now += ms; },
    attemptMs: 5,
  });
  assert.equal(result.value, 'fresh');
  assert.equal(firstFence(), false);
  finishFirst('stale');
  let current = true;
  const cancelled = await recoverViewerSession({
    request: async () => { throw new Error('transport'); },
    isCurrent: () => current,
    isAvailable: () => true,
    retentionDeadline: 10_001,
    now: () => now,
    sleep: async () => { current = false; },
  });
  assert.equal(cancelled.cancelled, true);
});

test('offline/hidden recovery does not send requests; event/manual triggers deduplicate and cool down', async () => {
  let now = 1;
  let requests = 0;
  await recoverViewerSession({
    request: async () => { requests += 1; },
    isCurrent: () => true,
    isAvailable: () => false,
    retentionDeadline: 10_001,
    now: () => now,
    waitForAvailability: async ({ deadline }) => { now = deadline; return false; },
    sleep: async ms => { now += ms; },
  });
  assert.equal(requests, 0);
  assert.equal(now, 10_001);
  assert.equal(mayStartViewerSessionRecovery({ inFlight: true, cooldownUntil: 0, now, available: true }), false);
  assert.equal(mayStartViewerSessionRecovery({ inFlight: false, cooldownUntil: now + 5000, now, available: true }), false);
  assert.equal(mayStartViewerSessionRecovery({ inFlight: false, cooldownUntil: now, now, available: false }), false);
  assert.equal(mayStartViewerSessionRecovery({ inFlight: false, cooldownUntil: now, now, available: true }), true);
});

test('online before the original deadline wakes the current offline generation exactly once', async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
  let now = 1_000;
  let requests = 0;
  let blocked = 0;
  let transient = 0;
  const pending = recoverViewerSession({
    request: async () => { requests += 1; return 'recovered'; },
    isCurrent: () => true,
    isAvailable: viewerSessionCanRecover,
    retentionDeadline: 11_000,
    now: () => now,
    onTransient: () => { transient += 1; },
    onDeadline: () => { blocked += 1; },
  });
  try {
    await Promise.resolve();
    assert.equal(requests, 0);
    now = 4_000;
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    for (let i = 0; i < 20; i += 1) {
      window.dispatchEvent(new window.Event('online'));
      window.dispatchEvent(new window.Event('focus'));
      document.dispatchEvent(new window.Event('visibilitychange'));
    }
    const result = await pending;
    assert.equal(result.value, 'recovered');
    assert.equal(requests, 1);
    assert.equal(blocked, 0, 'online before the deadline must not hide the retained page');
    assert.equal(transient, 0);
    assert.equal(now, 4_000);
  } finally {
    delete window.navigator.onLine;
  }
});

test('visible return during a backoff resumes remaining attempts without resetting budget or attempt count', async () => {
  let now = 1_000;
  let available = true;
  let requests = 0;
  let waits = 0;
  const sleeps = [];
  const result = await recoverViewerSession({
    request: async () => { requests += 1; throw new Error('transport'); },
    isCurrent: () => true,
    isAvailable: () => available,
    retentionDeadline: 11_000,
    now: () => now,
    sleep: async ms => {
      sleeps.push(ms);
      now += ms;
      if (sleeps.length === 1) available = false;
    },
    waitForAvailability: async ({ deadline }) => {
      waits += 1;
      assert.equal(deadline, 11_000);
      now = 4_000;
      available = true;
      return true;
    },
  });
  assert.equal(requests, 3, 'availability events do not grant extra attempts');
  assert.equal(waits, 1);
  assert.deepEqual(sleeps, [500, 1000, 6000]);
  assert.equal(now, 11_000);
  assert.ok(result.error);
});

test('a hidden overdue tab waits until it becomes visible', async () => {
  const originalNow = Date.now;
  let now = VIEWER_SESSION_REVALIDATE_MS + 20_000;
  let visibility = 'hidden';
  Date.now = () => now;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  let checks = 0;
  function Harness() {
    useViewerSessionRevalidation({
      enabled: true,
      validatedAt: 1,
      onRevalidate: () => { checks += 1; },
    });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    assert.equal(checks, 0);
    visibility = 'visible';
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    assert.equal(checks, 1);
  } finally {
    await act(async () => root.unmount());
    Date.now = originalNow;
  }
});

test('an offline due epoch starts retention once instead of stranding the scheduler latch', async () => {
  const originalNow = Date.now;
  Date.now = () => VIEWER_SESSION_REVALIDATE_MS + 20_000;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
  let checks = 0;
  const onRevalidate = () => { checks += 1; };
  function Harness() {
    useViewerSessionRevalidation({ enabled: true, validatedAt: 1, onRevalidate });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'));
      document.dispatchEvent(new window.Event('visibilitychange'));
    });
    assert.equal(checks, 1, 'offline expiry must start the bounded retention lifecycle');
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    await act(async () => window.dispatchEvent(new window.Event('online')));
    assert.equal(checks, 1, 'online does not create a competing initial generation');
  } finally {
    await act(async () => root.unmount());
    delete window.navigator.onLine;
    Date.now = originalNow;
  }
});

test('routine legacy role lookup returns a fresh authoritative projection each epoch', async () => {
  const member = { id: 'm1', tenant_id: 't1', role_id: 'r1' };
  const allowed = await resolveRoutineSessionRole(member, async () => ({
    id: 'r1', tenant_id: 't1', name: 'Allowed', excluded_features: [],
  }), 100);
  const revoked = await resolveRoutineSessionRole(member, async () => ({
    id: 'r1', tenant_id: 't1', name: 'Revoked', excluded_features: ['page_Events'],
  }), 100);

  assert.equal(allowed.status, 'ready');
  assert.deepEqual(allowed.role.excluded_features, []);
  assert.equal(revoked.status, 'ready');
  assert.deepEqual(revoked.role.excluded_features, ['page_Events']);
});

test('routine legacy role lookup is bounded and rejects foreign projections', async () => {
  await assert.rejects(
    resolveRoutineSessionRole(
      { id: 'm1', tenant_id: 't1', role_id: 'r1' },
      () => new Promise(() => {}),
      5,
    ),
    /timed out/,
  );
  await assert.rejects(
    resolveRoutineSessionRole(
      { id: 'm1', tenant_id: 't1', role_id: 'r1' },
      async () => ({ id: 'r1', tenant_id: 'other' }),
      100,
    ),
    /invalid/,
  );
});

test('embedded role lookup errors retry, but foreign projections immediately fail closed', async () => {
  const member = {
    id: 'm', tenant_id: 't', role_id: 'r',
    sessionRole: { member_id: 'm', tenant_id: 't', role_id: 'r', status: 'error' },
  };
  await assert.rejects(resolveRoutineSessionRole(member, () => assert.fail('no legacy fallback'), 100),
    error => error.authoritative === false);
  await assert.rejects(resolveRoutineSessionRole({
    ...member, sessionRole: { ...member.sessionRole, member_id: 'foreign' },
  }, () => assert.fail('no legacy fallback'), 100),
  error => error.authoritative === true);
});
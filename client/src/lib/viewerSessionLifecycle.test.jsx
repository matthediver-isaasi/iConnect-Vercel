import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { VIEWER_SESSION_REVALIDATE_MS } from './viewerSessionPreload.js';
import {
  resolveRoutineSessionRole,
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
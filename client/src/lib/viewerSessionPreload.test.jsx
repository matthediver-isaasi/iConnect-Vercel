import test from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import {
  acquireViewerSessionRequest,
  getViewerSessionScope,
  invalidateViewerSessionRequest,
  isViewerSessionRevalidationDue,
  useViewerSessionPreload,
  VIEWER_SESSION_REVALIDATE_MS,
} from './viewerSessionPreload.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function response(member) {
  let parses = 0;
  return {
    ok: true,
    status: 200,
    json: async () => {
      parses += 1;
      return member;
    },
    get parses() { return parses; },
  };
}

test('mounted preload starts before delayed settings and shares one parsed response', async () => {
  const originalFetch = globalThis.fetch;
  const pending = deferred();
  const raw = response({ id: 'member-a' });
  const calls = [];
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return pending.promise;
  };
  function Harness() {
    useViewerSessionPreload('tenant-a:/canvas:0');
    return <div />;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    assert.equal(calls.length, 1, 'auth starts without waiting for visibility settings');
    const consumer = acquireViewerSessionRequest('tenant-a:/canvas:0');
    pending.resolve(raw);
    const result = await consumer.promise;
    assert.equal(result.member.id, 'member-a');
    assert.equal(raw.parses, 1);
    consumer.cancel();
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test('initial branding resolution keeps the host-derived request scope stable', async () => {
  const originalFetch = globalThis.fetch;
  const pending = deferred();
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return pending.promise;
  };
  function Harness({ branding }) {
    const scope = getViewerSessionScope({
      tenantSlug: 'tenant-a',
      hostname: 'tenant-a.iconn.app',
      pathname: '/canvas',
      authRevision: 0,
    });
    useViewerSessionPreload(scope);
    return <div data-branding={branding?.id || ''} />;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness branding={null} />));
    await act(async () => root.render(<Harness branding={{ id: 'resolved-id' }} />));
    assert.equal(calls, 1, 'async branding metadata must not restart auth');
    pending.resolve(response({ id: 'member-a' }));
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test('ordinary route navigation shares one session generation', async () => {
  const originalFetch = globalThis.fetch;
  const pending = deferred();
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return pending.promise;
  };
  function Harness({ pathname }) {
    const scope = getViewerSessionScope({
      tenantSlug: 'tenant-a',
      hostname: 'tenant-a.iconn.app',
      pathname,
      authRevision: 3,
    });
    useViewerSessionPreload(scope);
    return <div data-pathname={pathname} />;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness pathname="/bookings" />));
    await act(async () => root.render(<Harness pathname="/events" />));
    assert.equal(calls, 1, 'client navigation must not restart session validation');
    pending.resolve(response({ id: 'member-a' }));
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test('session revalidation has a bounded expiry', async () => {
  const validatedAt = 10_000;
  assert.equal(
    isViewerSessionRevalidationDue(validatedAt, validatedAt + VIEWER_SESSION_REVALIDATE_MS - 1),
    false,
  );
  assert.equal(
    isViewerSessionRevalidationDue(validatedAt, validatedAt + VIEWER_SESSION_REVALIDATE_MS),
    true,
  );
  assert.equal(isViewerSessionRevalidationDue(0, validatedAt), true);
});

test('invalidating a completed request rejects retained consumers', async () => {
  const scope = 'settled-logout-scope';
  const raw = response({ id: 'old-member' });
  const fetchImpl = async () => raw;
  const settlingLease = acquireViewerSessionRequest(scope, fetchImpl);
  assert.equal((await settlingLease.promise).member.id, 'old-member');
  const retainedLease = acquireViewerSessionRequest(scope, fetchImpl);
  invalidateViewerSessionRequest(scope);
  await assert.rejects(retainedLease.promise, { name: 'AbortError' });
  retainedLease.cancel();
  settlingLease.cancel();
});

test('an invalidated generation rejects a late response even when fetch ignores abort', async () => {
  const oldResponse = deferred();
  const newResponse = deferred();
  const oldLease = acquireViewerSessionRequest('tenant-a:7', () => oldResponse.promise);
  invalidateViewerSessionRequest('tenant-a:7');
  const newLease = acquireViewerSessionRequest('tenant-a:8', () => newResponse.promise);

  oldResponse.resolve(response({ id: 'stale-member' }));
  newResponse.resolve(response({ id: 'current-member' }));
  await assert.rejects(oldLease.promise, { name: 'AbortError' });
  assert.equal((await newLease.promise).member.id, 'current-member');

  oldLease.cancel();
  newLease.cancel();
});

test('account scope change aborts stale request and cannot reuse its identity', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (_url, { signal }) => new Promise((resolve, reject) => {
    requests.push({ resolve, signal });
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  function Harness({ scope }) {
    useViewerSessionPreload(scope);
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness scope="tenant-a:/canvas:0" />));
    await act(async () => root.render(<Harness scope="tenant-a:/canvas:1" />));
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests.length, 2);
    requests[1].resolve(response({ id: 'member-b' }));
    const current = acquireViewerSessionRequest('tenant-a:/canvas:1');
    assert.equal((await current.promise).member.id, 'member-b');
    current.cancel();
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test('explicit logout invalidation and unmount abort outstanding requests', async () => {
  const originalFetch = globalThis.fetch;
  const signals = [];
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  function Harness({ scope }) {
    useViewerSessionPreload(scope);
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness scope="logout-scope" />));
    invalidateViewerSessionRequest('logout-scope');
    assert.equal(signals[0].aborted, true);
    await act(async () => root.render(<Harness scope="unmount-scope" />));
    await act(async () => root.unmount());
    assert.equal(signals.at(-1).aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('StrictMode cleanup leaves only the committed request alive', async () => {
  const originalFetch = globalThis.fetch;
  const signals = [];
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  function Harness() {
    useViewerSessionPreload('strict-scope');
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
    assert.equal(signals.length, 2);
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
  } finally {
    await act(async () => root.unmount());
    assert.equal(signals[1].aborted, true);
    globalThis.fetch = originalFetch;
  }
});
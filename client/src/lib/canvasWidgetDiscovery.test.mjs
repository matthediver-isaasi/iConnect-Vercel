import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { canvasWidgetDiscoveryOptions } from './canvasWidgetDiscovery.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('20 Canvas cards share one list and six distinct definitions, not 40 metadata requests', async () => {
  const client = new QueryClient();
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const subscriptions = [];
  const observers = [];
  const fetchJson = async (url, signal) => {
    calls.push(url);
    assert.ok(signal instanceof AbortSignal);
    await gate;
    return url.includes('/widgets?') ? { shared: [], palette: ['#123456'] } : { widget: { scope: 'shared' } };
  };
  try {
    for (let i = 0; i < 20; i++) {
      const options = canvasWidgetDiscoveryOptions({
        authScope: 'tenant:member:role', widgetId: `widget-${i % 6}`, ready: true, fetchJson,
      });
      for (const option of [options.list, options.detail]) {
        const observer = new QueryObserver(client, option);
        observers.push(observer);
        subscriptions.push(observer.subscribe(() => {}));
      }
    }
    assert.equal(calls.length, 7);
    assert.equal(calls.filter(url => url.includes('/widgets?')).length, 1);
    // Removing one card must not cancel metadata used by its siblings.
    subscriptions.shift()();
    subscriptions.shift()();
    release();
    await tick();
    assert.ok(observers.slice(2).every(observer => observer.getCurrentResult().isSuccess));
  } finally {
    release();
    subscriptions.forEach(unsubscribe => unsubscribe());
    await tick();
    assert.equal(client.getQueryCache().getAll().length, 0);
    client.clear();
  }
});

test('discovery waits for session readiness, isolates auth changes and cancels unused requests', async () => {
  const client = new QueryClient();
  const signals = [];
  const options = (authScope, ready) => canvasWidgetDiscoveryOptions({
    authScope, widgetId: 'same-widget', ready,
    fetchJson: (_url, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    },
  }).detail;
  const observer = new QueryObserver(client, options('tenant-a:member-a:role-a', false));
  const unsubscribe = observer.subscribe(() => {});
  try {
    await tick();
    assert.equal(signals.length, 0);
    observer.setOptions(options('tenant-a:member-a:role-a', true));
    assert.equal(signals.length, 1);
    observer.setOptions(options('tenant-b:member-b:role-b', true));
    assert.equal(signals.length, 2);
    assert.equal(signals[0].aborted, true);
    assert.equal(observer.getCurrentResult().data, undefined);
    unsubscribe();
    assert.equal(signals[1].aborted, true);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test('shared discovery preserves pagination, palette and denied-response failure', async () => {
  const urls = [];
  const options = canvasWidgetDiscoveryOptions({
    authScope: 'viewer', widgetId: 'widget', ready: true,
    fetchJson: async url => {
      urls.push(url);
      return {
        shared: [{ id: String(urls.length) }],
        palette: ['#123456'],
        pagination: { page: urls.length, pageSize: 1, pages: 2, hasMore: urls.length === 1 },
      };
    },
  });
  const result = await options.list.queryFn({ signal: new AbortController().signal });
  assert.equal(urls.length, 2);
  assert.deepEqual(result.shared.map(w => w.id), ['1', '2']);
  assert.deepEqual(result.palette, ['#123456']);
  const denied = canvasWidgetDiscoveryOptions({
    authScope: 'revoked', widgetId: 'widget', ready: true,
    fetchJson: async () => { throw new Error('denied'); },
  });
  await assert.rejects(denied.list.queryFn({}), /denied/);
  await assert.rejects(denied.detail.queryFn({}), /denied/);
});
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_CLICK_VISITOR_STORAGE_PREFIX,
  buildEventClickEndpoint,
  getEventClickTenantScope,
  getOrCreateEventClickVisitorId,
  sendEventClick,
} from './eventClickTracking.js';

const uuid = '00000000-0000-4000-8000-000000000001';
const eventUuid = '00000000-0000-4000-8000-000000000002';

function installStorage({ throwOnWrite = false } = {}) {
  const values = new Map();
  globalThis.window = {
    location: { hostname: 'tenant.iconn.app', origin: 'https://tenant.iconn.app' },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (throwOnWrite) throw new Error('storage blocked');
        values.set(key, String(value));
      },
    },
  };
  return values;
}

test('visitor UUID persists per tenant but is not shared between tenants', () => {
  const values = installStorage();

  const first = getOrCreateEventClickVisitorId('tenant-a');
  const second = getOrCreateEventClickVisitorId('tenant-a');
  const otherTenant = getOrCreateEventClickVisitorId('tenant-b');

  assert.equal(second, first);
  assert.match(first, /^[0-9a-f-]{36}$/i);
  assert.notEqual(otherTenant, first);
  assert.equal(values.get(`${EVENT_CLICK_VISITOR_STORAGE_PREFIX}tenant-a`), first);
  assert.equal(values.get(`${EVENT_CLICK_VISITOR_STORAGE_PREFIX}tenant-b`), otherTenant);
  assert.equal(getEventClickTenantScope(), 'host:tenant.iconn.app');
});

test('storage failures opt out without throwing', () => {
  installStorage({ throwOnWrite: true });
  assert.equal(getOrCreateEventClickVisitorId('tenant-a'), null);
});

test('event click request is tenant-aware, keepalive, and failure-isolated', async () => {
  installStorage();
  const calls = [];
  const sent = sendEventClick({
    eventId: eventUuid,
    eventType: 'simple',
    visitorId: uuid,
    tenantSlug: 'tenant-a',
    fetchImpl: (url, options) => {
      calls.push({ url, options });
      return Promise.resolve({ ok: true });
    },
  });
  assert.equal(sent, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].url, '/api/public/event-click?tenant=tenant-a');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.keepalive, true);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    eventId: eventUuid,
    eventType: 'simple',
    visitorId: uuid,
  });

  assert.equal(sendEventClick({
    eventId: 'event-1',
    eventType: 'complex',
    visitorId: uuid,
    fetchImpl: () => { throw new Error('network down'); },
  }), false);
  assert.equal(buildEventClickEndpoint('tenant-a'), '/api/public/event-click?tenant=tenant-a');
});
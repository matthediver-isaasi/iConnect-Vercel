import assert from 'node:assert/strict';
import test from 'node:test';
import { getTenantSlugFromLocation } from './publicClient.js';

test('preview hosts allow explicit tenants while tenant domains remain authoritative', () => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  const cases = [
    ['iconnect--sandbox.worf.replit.dev', '?tenant=gfi', 'gfi'],
    ['project.owner.replit.dev', '?tenant=bnms', 'bnms'],
    ['project.owner.repl.co', '?tenant=gfi', 'gfi'],
    ['localhost', '?tenant=gfi', 'gfi'],
    ['127.0.0.1', '?tenant=gfi', 'gfi'],
    ['iconnect--sandbox.worf.replit.dev', '', null],
    ['gfi.iconn.app', '?tenant=bnms', 'gfi'],
    ['gfi.dev.iconn.app', '?tenant=bnms', 'gfi'],
    ['typo.iconn.app', '?tenant=gfi', 'typo'],
    ['tenant.replit.dev.example.com', '?tenant=gfi', 'tenant'],
  ];
  try {
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };
    for (const [hostname, search, expected] of cases) {
      globalThis.window = { location: { hostname, search } };
      assert.equal(getTenantSlugFromLocation(), expected, `${hostname}${search}`);
    }
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
});

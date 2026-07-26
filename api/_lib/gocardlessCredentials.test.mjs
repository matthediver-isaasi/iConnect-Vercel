// Per-tenant GoCardless credential resolution tests.
// Run: node --test api/_lib/gocardlessCredentials.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getGocardlessCredentials, envGocardlessCredentials } from './gocardlessCredentials.js';
import { createGocardlessClient } from './gocardless.js';

const TENANT = '22222222-2222-2222-2222-222222222222';

function fakeDb(row, error = null) {
  return {
    from(table) {
      assert.equal(table, 'tenant_integrations');
      const q = {
        select() { return q; },
        eq() { return q; },
        maybeSingle: async () => ({ data: row, error }),
      };
      return q;
    },
  };
}

test('tenant with enabled gocardless integration uses tenant credentials', async () => {
  const db = fakeDb({
    is_enabled: true,
    credentials: { access_token: 'sandbox_tenant_token', webhook_secret: 'tenant-secret', environment: 'sandbox' },
  });
  const creds = await getGocardlessCredentials(TENANT, { db });
  assert.equal(creds.source, 'tenant');
  assert.equal(creds.tenantId, TENANT);
  assert.equal(creds.accessToken, 'sandbox_tenant_token');
  assert.equal(creds.webhookSecret, 'tenant-secret');
  assert.equal(creds.environment, 'sandbox');
});

test('tenant without an integration row falls back to platform env', async () => {
  const db = fakeDb(null);
  const creds = await getGocardlessCredentials(TENANT, { db });
  assert.equal(creds.source, 'platform-env');
});

test('disabled tenant integration falls back to platform env', async () => {
  const db = fakeDb({ is_enabled: false, credentials: { access_token: 'sandbox_x' } });
  const creds = await getGocardlessCredentials(TENANT, { db });
  assert.equal(creds.source, 'platform-env');
});

test('integration row missing access_token falls back to platform env', async () => {
  const db = fakeDb({ is_enabled: true, credentials: { webhook_secret: 'only-secret' } });
  const creds = await getGocardlessCredentials(TENANT, { db });
  assert.equal(creds.source, 'platform-env');
});

test('no tenantId resolves platform env without touching the db', async () => {
  const creds = await getGocardlessCredentials(null, { db: { from() { throw new Error('db should not be queried'); } } });
  assert.equal(creds.source, 'platform-env');
  assert.deepEqual(Object.keys(creds).sort(), Object.keys(envGocardlessCredentials()).sort());
});

test('db error is surfaced, not silently swallowed', async () => {
  const db = fakeDb(null, { message: 'boom' });
  await assert.rejects(() => getGocardlessCredentials(TENANT, { db }), /Failed to fetch GoCardless credentials/);
});

test('client refuses env/token mismatch (live env, sandbox token)', async () => {
  const client = createGocardlessClient({ source: 'tenant', tenantId: TENANT, environment: 'live', accessToken: 'sandbox_abc' });
  await assert.rejects(() => client.getMandate('MD1'), /environment=live but the access token is a sandbox token/);
});

test('client refuses env/token mismatch (sandbox env, live token)', async () => {
  const client = createGocardlessClient({ source: 'tenant', tenantId: TENANT, environment: 'sandbox', accessToken: 'live_abc' });
  await assert.rejects(() => client.getMandate('MD1'), /environment=sandbox but the access token is a live token/);
});

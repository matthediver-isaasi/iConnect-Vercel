import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  isTenantUuid,
  normalizeEligibleFormRelationshipDiscovery,
  PublicClient,
} from './publicClient.js';

test('tenant context accepts UUIDs only, never tenant slugs', () => {
  assert.equal(isTenantUuid('11111111-1111-4111-8111-111111111111'), true);
  assert.equal(isTenantUuid('tenant-bnms'), false);
  assert.equal(isTenantUuid(null), false);
});

test('relationship discovery accepts the endpoint envelope', () => {
  const response = {
    data: [{ id: 'relationship-1' }],
    custom_objects: [{ id: 'object-1', fields: [] }],
  };
  assert.deepEqual(normalizeEligibleFormRelationshipDiscovery(response), response);
});

test('relationship discovery accepts one transport data wrapper', () => {
  const response = {
    data: {
      data: [{ id: 'relationship-1' }],
      custom_objects: [{ id: 'object-1', fields: [] }],
    },
  };
  assert.deepEqual(
    normalizeEligibleFormRelationshipDiscovery(response),
    response.data,
  );
});

test('missing relationship discovery envelope is an error, not an empty result', () => {
  assert.throws(
    () => normalizeEligibleFormRelationshipDiscovery({ data: [] }),
    /expected data and custom_objects arrays/,
  );
  assert.throws(
    () => normalizeEligibleFormRelationshipDiscovery([]),
    /expected data and custom_objects arrays/,
  );
});

test('discovery uses the active tenant header without stale public-client query injection', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      data: [],
      custom_objects: [],
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const originalFetch = globalThis.fetch;
  const { port } = server.address();
  globalThis.fetch = (input, options) => (
    originalFetch(new URL(input, `http://127.0.0.1:${port}`), options)
  );

  try {
    const client = new PublicClient();
    client.tenantSlug = 'stale-slug-from-previous-tenant';
    const response = await client.listEligibleFormRelationships('form-1', {
      tenantId: '11111111-1111-4111-8111-111111111111',
    });
    assert.deepEqual(response, { data: [], custom_objects: [] });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/forms/form-1/relationship-definitions');
    assert.equal(requests[0].headers['x-tenant-id'], '11111111-1111-4111-8111-111111111111');
    assert.equal(requests[0].headers.cookie, undefined);
    await assert.rejects(
      () => client.listEligibleFormRelationships(null),
      /saved form is required/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
  }
});
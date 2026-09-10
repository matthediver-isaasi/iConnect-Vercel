import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomObjectDirectoryError } from './customObjectDirectory.js';
import { createHandler } from '../organisation-directory/custom-object-file.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

const context = {
  isAuthenticated: true,
  tenantId: '10000000-0000-4000-8000-000000000001',
  roleId: '20000000-0000-4000-8000-000000000002',
};
const sourceKey = 'object-field:30000000-0000-4000-8000-000000000003:source:40000000-0000-4000-8000-000000000004:50000000-0000-4000-8000-000000000005';

test('download streams bytes without exposing a storage path or redirect', async () => {
  const calls = [];
  let receivedAdmin;
  const blob = new Blob(['secret bytes'], { type: 'text/plain' });
  const db = {
    storage: {
      from(bucket) {
        calls.push(['bucket', bucket]);
        return {
          async download(path) {
            calls.push(['path', path]);
            return { data: blob, error: null };
          },
        };
      },
    },
  };
  const handler = createHandler({
    db,
    getTenantContext: async () => context,
    hasAdminAccess: async () => true,
    createCustomObjectDirectory: ({ isAdmin }) => {
      receivedAdmin = isAdmin;
      return {
        async file(input) {
          calls.push(['authorization', input]);
          return {
            bucket: 'private-uploads',
            storage_path: `${context.tenantId}/custom-object-files/40000000-0000-4000-8000-000000000004/50000000-0000-4000-8000-000000000005/60000000-0000-4000-8000-000000000006-report.pdf`,
            file_name: 'report.pdf',
            mime_type: 'application/pdf',
          };
        },
      };
    },
  });
  const res = response();
  await handler({
    method: 'GET',
    headers: {},
    query: {
      organization_id: 'org',
      source_key: sourceKey,
      record_id: 'record',
      file_index: '0',
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'private, no-store, max-age=0');
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.equal(res.headers['Content-Disposition'], 'attachment; filename="report.pdf"');
  assert.equal(Buffer.isBuffer(res.body), true);
  assert.equal(receivedAdmin, true);
  assert.deepEqual(calls.map((call) => call[0]), ['authorization', 'bucket', 'path']);
  assert.doesNotMatch(JSON.stringify(res.headers), /private-uploads|custom-objects/);
});

test('defence-in-depth rejects forged protected-asset paths before storage', async () => {
  for (const storagePath of [
    `${context.tenantId}/galleries/private-gallery/1700000000000-abcdefg-photo.jpg`,
    `${context.tenantId}/opportunities/private-opportunity/1700000000000-abcdefg-contract.pdf`,
    `${context.tenantId}/custom-object-files/another-object/50000000-0000-4000-8000-000000000005/60000000-0000-4000-8000-000000000006-file.pdf`,
    `${context.tenantId}/custom-object-files/40000000-0000-4000-8000-000000000004/another-field/60000000-0000-4000-8000-000000000006-file.pdf`,
  ]) {
    let storageCalled = false;
    const handler = createHandler({
      db: {
        storage: {
          from() {
            storageCalled = true;
            throw new Error('must not download');
          },
        },
      },
      getTenantContext: async () => context,
      hasAdminAccess: async () => false,
      createCustomObjectDirectory: () => ({
        async file() {
          return {
            bucket: 'private-uploads',
            storage_path: storagePath,
            file_name: 'private.pdf',
          };
        },
      }),
    });
    const res = response();
    await handler({
      method: 'GET',
      headers: {},
      query: {
        organization_id: 'org',
        source_key: sourceKey,
        record_id: 'record',
      },
    }, res);
    assert.equal(res.statusCode, 404, storagePath);
    assert.equal(storageCalled, false, storagePath);
  }
});

test('copied links re-run authorization and cannot download after revocation', async () => {
  let storageCalled = false;
  const handler = createHandler({
    db: {
      storage: {
        from() {
          storageCalled = true;
          throw new Error('must not download');
        },
      },
    },
    getTenantContext: async () => context,
    hasAdminAccess: async () => false,
    createCustomObjectDirectory: () => ({
      async file() {
        throw new CustomObjectDirectoryError(404, 'File source not found');
      },
    }),
  });
  const res = response();
  await handler({
    method: 'GET',
    headers: {},
    query: {
      organization_id: 'org',
      source_key: 'copied-source',
      record_id: 'record',
      file_index: '0',
    },
  }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(storageCalled, false);
});

test('a different role denial fails before storage access', async () => {
  let storageCalled = false;
  const handler = createHandler({
    db: {
      storage: {
        from() {
          storageCalled = true;
          throw new Error('must not download');
        },
      },
    },
    getTenantContext: async () => ({ ...context, roleId: 'other-role' }),
    hasAdminAccess: async () => false,
    createCustomObjectDirectory: () => ({
      async file() {
        throw new CustomObjectDirectoryError(403, 'Directory access denied');
      },
    }),
  });
  const res = response();
  await handler({
    method: 'GET',
    headers: {},
    query: {
      organization_id: 'org',
      source_key: 'source',
      record_id: 'record',
    },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(storageCalled, false);
});
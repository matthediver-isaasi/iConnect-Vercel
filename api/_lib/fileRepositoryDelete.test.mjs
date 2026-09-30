import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deleteRepositoryFile, resolveRepositoryStorageTarget } from './fileRepositoryDelete.js';

const origin = 'https://lvmzliemqnieeoruhkik.supabase.co';
const context = { isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'admin' };
const file = {
  id: 'file-1', tenant_id: 'tenant-a', bucket: 'public-assets',
  storage_path: 'tenant-a/uploads/report.docx',
  file_url: `${origin}/storage/v1/object/public/public-assets/tenant-a/uploads/report.docx`,
};

function fixture(options = {}) {
  const calls = [];
  let record = options.record === undefined ? { ...file } : options.record;
  let metadataFailure = !!options.metadataFailure;
  const db = {
    storage: { from(bucket) {
      return { async remove(paths) {
        calls.push(['storage', bucket, paths]);
        if (options.storageThrows) throw new Error('provider unavailable');
        return { data: [], error: options.storageError || null };
      } };
    } },
    from(table) {
      assert.equal(table, 'file_repository');
      let deleting = false;
      const filters = {};
      const builder = {
        select() { return this; },
        eq(k, v) { filters[k] = v; return this; },
        neq() { return this; },
        order() { return this; },
        delete() { deleting = true; return this; },
        async maybeSingle() {
          calls.push(['read', filters]);
          return { data: record?.tenant_id === filters.tenant_id ? record : null, error: options.readError };
        },
        async range(start, end) {
          calls.push(['references', filters, start, end]);
          return { data: (options.references || []).slice(start, end + 1), error: options.referenceError };
        },
        then(resolve) {
          assert.equal(deleting, true);
          calls.push(['metadata', filters]);
          if (!metadataFailure) record = null;
          return Promise.resolve({ error: metadataFailure ? { message: 'db unavailable' } : null }).then(resolve);
        },
      };
      return builder;
    },
  };
  return {
    calls,
    retryMetadata() { metadataFailure = false; },
    run(overrides = {}) {
      return deleteRepositoryFile({
        db, context, id: file.id, storageOrigin: origin,
        hasFeatureAccess: async () => true, ...overrides,
      });
    },
  };
}

test('public deletion removes storage first, tenant-scopes metadata, repeated request is safe', async () => {
  const f = fixture();
  assert.equal((await f.run()).status, 200);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'references', 'storage', 'metadata']);
  assert.deepEqual(f.calls[2], ['storage', file.bucket, [file.storage_path]]);
  assert.deepEqual(f.calls[3][1], { tenant_id: context.tenantId, id: file.id });
  assert.equal((await f.run()).body.alreadyDeleted, true);
  assert.equal(f.calls.filter(c => c[0] === 'storage').length, 1);
});

test('private secure URL and URL-only legacy vault records resolve exactly', async () => {
  const privateFile = { ...file, bucket: 'private-uploads',
    file_url: '/api/storage/secure-url?bucket=private-uploads&path=tenant-a%2Fuploads%2Freport.docx&redirect=true' };
  const f = fixture({ record: privateFile });
  assert.equal((await f.run()).status, 200);
  assert.equal(f.calls.find(c => c[0] === 'storage')[1], 'private-uploads');
  assert.deepEqual(resolveRepositoryStorageTarget({
    ...file, bucket: undefined, storage_path: undefined,
    file_url: file.file_url.replace(origin, 'https://vault.iconn.app'),
  }, context.tenantId, origin), { bucket: file.bucket, path: file.storage_path });
});

test('missing objects (successful empty remove response) finish metadata deletion', async () => {
  const f = fixture();
  assert.equal((await f.run()).status, 200);
  assert.ok(f.calls.some(c => c[0] === 'metadata'));
});

for (const storageError of [{ status: 403 }, { status: 404 }, { status: 500 }]) {
  test(`provider ${storageError.status} is not treated as object absence`, async () => {
    const f = fixture({ storageError });
    assert.equal((await f.run()).status, 502);
    assert.ok(!f.calls.some(c => c[0] === 'metadata'));
    assert.equal((await f.run()).status, 502);
  });
}

test('provider exception retains metadata; metadata failure permits complete retry', async () => {
  const thrown = fixture({ storageThrows: true });
  assert.equal((await thrown.run()).status, 500);
  assert.ok(!thrown.calls.some(c => c[0] === 'metadata'));
  const f = fixture({ metadataFailure: true });
  assert.match((await f.run()).body.error, /Storage object removed/);
  f.retryMetadata();
  assert.equal((await f.run()).status, 200);
  assert.equal(f.calls.filter(c => c[0] === 'storage').length, 2);
});

for (const [name, ctx, status] of [
  ['anonymous', {}, 401],
  ['missing tenant', { isAuthenticated: true, tenantUserId: 'admin' }, 403],
  ['stale tab', { ...context, tenantMismatch: true }, 409],
  ['unprivileged member', { isAuthenticated: true, tenantId: 'tenant-a', roleId: 'role' }, 403],
]) {
  test(`${name} cannot access deletion`, async () => {
    const f = fixture();
    assert.equal((await f.run({ context: ctx, hasFeatureAccess: async () => false })).status, status);
    assert.deepEqual(f.calls, []);
  });
}

test('feature-authorized member access includes member exclusions', async () => {
  const f = fixture();
  const ctx = { isAuthenticated: true, tenantId: 'tenant-a', roleId: 'role', memberExcludedFeatures: ['content.files'] };
  const result = await f.run({ context: ctx, hasFeatureAccess: async (...args) => {
    assert.deepEqual(args, ['role', 'content.files', ['content.files']]);
    return false;
  } });
  assert.equal(result.status, 403);
});

test('cross-tenant row is not revealed or deleted', async () => {
  const f = fixture({ record: { ...file, tenant_id: 'tenant-b' } });
  assert.equal((await f.run()).body.alreadyDeleted, true);
  assert.deepEqual(f.calls.map(c => c[0]), ['read']);
});

for (const [name, changes] of [
  ['cross-tenant path', { storage_path: 'tenant-b/uploads/report.docx' }],
  ['unapproved bucket', { bucket: 'other' }],
  ['incomplete metadata', { bucket: undefined }],
  ['mismatched path', { storage_path: 'tenant-a/uploads/other.docx' }],
  ['external URL', { file_url: 'https://evil.example/storage/v1/object/public/public-assets/tenant-a/uploads/report.docx' }],
  ['other Supabase project', { file_url: file.file_url.replace(origin, 'https://other.supabase.co') }],
  ['encoded slash traversal', { file_url: `${origin}/storage/v1/object/public/public-assets/tenant-a/uploads/%2e%2e%2Freport.docx` }],
  ['literal traversal', { file_url: `${origin}/storage/v1/object/public/public-assets/tenant-a/uploads/../report.docx` }],
  ['double encoding', { storage_path: 'tenant-a/uploads/%252e%252e/report.docx' }],
  ['backslash', { storage_path: 'tenant-a/uploads/\\report.docx' }],
  ['ambiguous query', { file_url: '/api/storage/secure-url?bucket=public-assets&bucket=private-uploads&path=tenant-a/uploads/report.docx' }],
  ['credentials', { file_url: file.file_url.replace('https://', 'https://user:pass@') }],
  ['missing location', { file_url: null, bucket: null, storage_path: null }],
]) {
  test(`rejects ${name} before any storage mutation`, async () => {
    const f = fixture({ record: { ...file, ...changes } });
    assert.equal((await f.run()).status, 409);
    assert.ok(!f.calls.some(c => c[0] === 'storage'));
  });
}

test('vault alias cannot point into a non-production storage client', () => {
  assert.throws(() => resolveRepositoryStorageTarget({
    ...file, file_url: file.file_url.replace(origin, 'https://vault.iconn.app'),
  }, context.tenantId, 'https://source.supabase.co'));
});

for (const reference of [
  { ...file, id: 'other' },
  { ...file, id: 'other', storage_path: null, bucket: null },
  { ...file, id: 'other', file_url: 'https://invalid.example/other' },
]) {
  test('shared metadata or legacy URL reference blocks removal, including inconsistent rows', async () => {
    const f = fixture({ references: [reference] });
    assert.equal((await f.run()).status, 409);
    assert.ok(!f.calls.some(c => c[0] === 'storage'));
  });
}

test('reference scan paginates and detects shared object beyond first page', async () => {
  const references = Array.from({ length: 500 }, (_, i) => ({ id: `other-${i}` }));
  references.push({ ...file, id: 'shared' });
  const f = fixture({ references });
  assert.equal((await f.run()).status, 409);
  assert.equal(f.calls.filter(c => c[0] === 'references').length, 2);
});

for (const key of ['readError', 'referenceError']) {
  test(`${key} fails closed`, async () => {
    const f = fixture({ [key]: { message: 'unavailable' } });
    assert.equal((await f.run()).status, 500);
    assert.ok(!f.calls.some(c => c[0] === 'storage'));
  });
}

test('generic boundary dispatches normalized FileRepository DELETE only, leaving folders unchanged', () => {
  const source = readFileSync(new URL('../entities/[entity]/[id].js', import.meta.url), 'utf8');
  assert.match(source, /entityNorm === 'filerepository' && req.method === 'DELETE'/);
  assert.match(source, /db: requestDatabase/);
  assert.ok(source.indexOf("entityNorm === 'filerepository' && req.method === 'DELETE'") < source.indexOf("} else if (req.method === 'DELETE')"));
});
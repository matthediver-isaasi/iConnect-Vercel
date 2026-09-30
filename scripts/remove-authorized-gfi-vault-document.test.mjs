import test from 'node:test';
import assert from 'node:assert/strict';
import { removeAuthorizedDocument, TARGET } from './remove-authorized-gfi-vault-document.mjs';

function fixture({ wrongTenant = false, references = false, removeError = false, absent = false, cache = false, infoError = false } = {}) {
  const removals = [];
  let deleted = absent;
  const db = {
    from(table) {
      const q = {
        select() { return q; }, eq() { return q; },
        async single() { return { data: { id: TARGET.tenantId, slug: wrongTenant ? 'other' : 'gfi', name: 'Graduate Futures Institute' } }; },
        async limit() { return { data: references ? [{ id: 'reference' }] : [] }; },
      };
      assert.ok(['tenant', 'file_repository'].includes(table));
      return q;
    },
    storage: { from(bucket) {
      assert.equal(bucket, TARGET.bucket);
      return {
        async info(path) {
          assert.equal(path, TARGET.path);
          if (infoError) return { error: { code: 'AccessDenied' } };
          return deleted ? { error: { status: 400, statusCode: '404', message: 'Object not found' } } : { data: {
            id: TARGET.objectId, name: TARGET.path, bucketId: TARGET.bucket, etag: TARGET.etag, size: TARGET.size,
          } };
        },
        async remove(paths) {
          removals.push(paths);
          if (removeError) return { error: { code: 'AccessDenied' } };
          deleted = true;
          return { data: [] };
        },
      };
    } },
  };
  const fetcher = async (url, options) => options.method === 'HEAD'
    ? new Response(null, { status: 200, headers: { etag: TARGET.etag } })
    : cache && url.includes('vault.iconn.app')
      ? new Response('document', { status: 200 })
      : new Response(JSON.stringify({ statusCode: '404', message: 'Object not found' }),
        { status: 400, headers: { 'content-type': 'application/json', 'cf-cache-status': 'MISS' } });
  return { db, fetcher, removals };
}

test('read-only preflight never deletes', async () => {
  const f = fixture();
  assert.equal((await removeAuthorizedDocument(f)).identityVerified, true);
  assert.deepEqual(f.removals, []);
});
test('apply removes only pinned object and verifies both URLs', async () => {
  const f = fixture();
  const result = await removeAuthorizedDocument({ ...f, apply: true });
  assert.deepEqual(f.removals, [[TARGET.path]]);
  assert.equal(result.storageAbsent, true);
  assert.equal(result.urls.length, 2);
});
test('already absent retry verifies absence without another delete', async () => {
  const f = fixture({ absent: true });
  assert.equal((await removeAuthorizedDocument({ ...f, apply: true })).removed, false);
  assert.deepEqual(f.removals, []);
});
for (const flag of ['wrongTenant', 'references', 'infoError']) {
  test(`${flag} fails closed before deletion`, async () => {
    const f = fixture({ [flag]: true });
    await assert.rejects(removeAuthorizedDocument({ ...f, apply: true }));
    assert.deepEqual(f.removals, []);
  });
}
test('provider failure never claims success', async () => {
  await assert.rejects(removeAuthorizedDocument({ ...fixture({ removeError: true }), apply: true }), /Storage deletion failed/);
});
test('cached document fails verification even when origin is absent', async () => {
  await assert.rejects(removeAuthorizedDocument({ ...fixture({ cache: true }), apply: true }), /original still serves content/);
});
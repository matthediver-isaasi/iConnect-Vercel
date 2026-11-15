import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicGroupContentHandler } from './member-group-content.js';
import { persistedResourceStorageTarget, guestResourceEligible } from '../_lib/publicMemberGroupAccess.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';
const resourceId = '33333333-3333-4333-8333-333333333333';
const threadId = '44444444-4444-4444-8444-444444444444';
const group = { id: groupId, tenant_id: tenant, is_public: true, is_active: true, name: 'Public group', forum_enabled: true, resource_subcategories: ['Library'], admin_secret: 'never' };
const resource = { id: resourceId, tenant_id: tenant, is_public: true, status: 'active', member_group_id: groupId, title: 'Guide',
  resource_type: 'download', target_url: `/api/storage/secure-url?bucket=private-uploads&path=${tenant}/uploads/guide.pdf`, private_notes: 'never' };
function fixture(overrides = {}) {
  const tables = { member_group: [{ ...group }], system_settings: [], resource: [{ ...resource }], resource_category: [],
    file_repository: [{ id: 'file', tenant_id: tenant, bucket: 'private-uploads', storage_path: `${tenant}/uploads/guide.pdf`, file_url: resource.target_url }],
    forum_category: [{ id: 'category', tenant_id: tenant, group_id: groupId, is_active: true }],
    forum_thread: [{ id: threadId, tenant_id: tenant, category_id: 'category', title: 'Discussion', is_hidden: false }],
    forum_post: [
      { id: 'visible', tenant_id: tenant, thread_id: threadId, content: 'Visible reply', is_hidden: false, is_deleted: false },
      { id: 'hidden', tenant_id: tenant, thread_id: threadId, content: 'Secret', is_hidden: true },
      { id: 'deleted', tenant_id: tenant, thread_id: threadId, content: 'Deleted', is_deleted: true },
      { id: 'foreign', tenant_id: 'other', thread_id: threadId, content: 'Other tenant' },
    ], ...overrides };
  const signs = [];
  const db = {
    storage: { from: bucket => ({ createSignedUrl: async (path, expiry) => {
      signs.push({ bucket, path, expiry }); return { data: { signedUrl: 'https://storage.invalid/one-minute' } };
    } }) },
    from(table) {
      let filters = [], first = 0, last = Infinity, columns = '*';
      const q = {
        select(c) { columns = c; return q; },
        eq(k, v) { filters.push(r => r[k] === v); return q; },
        is(k, v) { filters.push(r => (r[k] ?? null) === v); return q; },
        in(k, v) { filters.push(r => v.includes(r[k])); return q; },
        overlaps(k, v) { filters.push(r => r[k]?.some(s => v.includes(s))); return q; },
        or(value) { const k = value.split('.')[0]; filters.push(r => r[k] == null || r[k] === value.endsWith('true')); return q; },
        not(k, operator, value) { filters.push(r => !String(r[k] || '').startsWith('deleted_')); return q; },
        order() { return q; }, limit(n) { last = n - 1; return q; },
        range(a, b) { first = a; last = b; return q; },
        then(resolve, reject) {
          let data = (tables[table] || []).filter(r => filters.every(f => f(r))).slice(first, last + 1);
          if (columns !== '*') data = data.map(r => Object.fromEntries(columns.split(',').map(k => [k.trim(), r[k.trim()]])));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      }; return q;
    },
  };
  const handler = createPublicGroupContentHandler({ db, resolveTenant: async () => ({ id: tenant }), storageOrigin: 'https://storage.invalid' });
  async function request(query = {}, method = 'GET') {
    const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, query: { groupId, ...query } }, res); return res;
  }
  return { tables, signs, request };
}
test('public group detail is allowlisted, uncached and tenant scoped', async () => {
  const f = fixture();
  const res = await f.request();
  assert.equal(res.code, 200);
  assert.equal(res.body.name, 'Public group');
  assert.equal(res.body.admin_secret, undefined);
  assert.match(res.headers['Cache-Control'], /no-store/);
  f.tables.member_group[0].tenant_id = 'other';
  assert.equal((await f.request()).code, 404);
});
test('private, inactive, missing and revoked groups deny every read and signing', async () => {
  for (const change of [{ is_public: false }, { is_active: false }, { tenant_id: 'other' }]) {
    const f = fixture(); Object.assign(f.tables.member_group[0], change);
    for (const action of ['detail', 'members', 'resources', 'resource', 'download', 'events', 'vacancies', 'threads', 'thread']) {
      assert.equal((await f.request({ action, resourceId, threadId })).code, 404);
    }
    assert.equal(f.signs.length, 0);
  }
  const f = fixture();
  assert.equal((await f.request({ action: 'download', resourceId })).code, 200);
  f.tables.member_group[0].is_public = false;
  assert.equal((await f.request({ action: 'download', resourceId })).code, 404);
});
test('resource signing uses only persisted tenant-prefixed paths', async () => {
  const f = fixture();
  const res = await f.request({ action: 'download', resourceId, path: 'other/secret', bucket: 'other' });
  assert.equal(res.code, 200);
  assert.deepEqual(f.signs, [{ bucket: 'private-uploads', path: `${tenant}/uploads/guide.pdf`, expiry: 60 }]);
  const display = await f.request({ action: 'resource', resourceId });
  assert.equal(display.body.target_url, undefined);
  assert.equal(display.body.private_notes, undefined);
  assert.equal(display.body.can_download, true);
  f.tables.resource[0].member_group_id = 'unrelated';
  assert.equal((await f.request({ action: 'download', resourceId })).code, 404);
});
test('resource independent gates remain enforced; only owned or linked tenant-wide resources qualify', async () => {
  for (const change of [
    { linked_events: [{ event_id: 'x' }] }, { allowed_role_ids: ['members'] },
    { release_date: '2999-01-01' }, { release_date: 'invalid' }, { status: 'draft' },
    { tenant_id: 'other' }, { member_group_id: 'other', subcategories: ['Library'] },
  ]) {
    const f = fixture(); Object.assign(f.tables.resource[0], change);
    assert.equal((await f.request({ action: 'resource', resourceId })).code, 404);
  }
  assert.equal(guestResourceEligible({ ...resource, member_group_id: null, subcategories: ['Library'] }, group, new Set()), true);
  assert.equal(guestResourceEligible({ ...resource, subcategories: ['Private'] }, group, new Set(['Private'])), false);
});
test('resource Public consent is required for owned and linked listings, detail and downloads', async () => {
  for (const member_group_id of [groupId, null]) {
    for (const is_public of [false, null, undefined]) {
      const f = fixture();
      Object.assign(f.tables.resource[0], { member_group_id, is_public, subcategories: ['Library'] });
      assert.deepEqual((await f.request({ action: 'resources' })).body.records, []);
      assert.equal((await f.request({ action: 'resource', resourceId })).code, 404);
      assert.equal((await f.request({ action: 'download', resourceId })).code, 404);
      assert.equal(f.signs.length, 0);
      f.tables.resource[0].is_public = true;
      assert.equal((await f.request({ action: 'resources' })).body.records.length, 1);
      assert.equal((await f.request({ action: 'resource', resourceId })).code, 200);
      assert.equal((await f.request({ action: 'download', resourceId })).code, 200);
    }
  }
});
test('thread lineage and hidden/deleted posts are filtered without author records', async () => {
  const f = fixture();
  const res = await f.request({ action: 'thread', threadId });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.records.map(p => p.id), ['visible']);
  assert.equal(res.body.records[0].created_by, undefined);
  f.tables.forum_thread[0].is_hidden = true;
  assert.equal((await f.request({ action: 'thread', threadId })).code, 404);
  f.tables.forum_thread[0].is_hidden = false;
  f.tables.forum_category[0].group_id = 'unrelated';
  assert.equal((await f.request({ action: 'thread', threadId })).code, 404);
});
test('all mutations are rejected before any group lookup', async () => {
  const f = fixture();
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) assert.equal((await f.request({}, method)).code, 405);
});
test('role-restricted group discussions remain private despite group publication', async () => {
  for (const roles of [['Chair'], 'Chair']) {
    const f = fixture(); f.tables.member_group[0].forum_enabled_roles = roles;
    assert.equal((await f.request()).body.forum_enabled, false);
    assert.equal((await f.request({ action: 'threads' })).code, 404);
    assert.equal((await f.request({ action: 'thread', threadId })).code, 404);
  }
});
test('download consent cannot authorize independently protected files or unrelated repository folders', async () => {
  for (const namespace of ['galleries', 'opportunities', 'attachments', 'documents', 'form-submissions']) {
    const f = fixture();
    f.tables.resource[0].target_url = `/api/storage/secure-url?bucket=private-uploads&path=${tenant}/${namespace}/secret`;
    assert.equal((await f.request({ action: 'download', resourceId })).code, 404);
    assert.equal(f.signs.length, 0);
  }
  for (const table of ['gallery_photo', 'opportunity_document']) {
    const f = fixture({ [table]: [{ id: 'protected', tenant_id: tenant, bucket: 'private-uploads', storage_path: `${tenant}/uploads/guide.pdf` }] });
    assert.equal((await f.request({ action: 'download', resourceId })).code, 404);
    assert.equal(f.signs.length, 0);
  }
  const f = fixture();
  f.tables.file_repository[0].folder_id = 'foreign-folder';
  f.tables.file_repository_folder = [{ id: 'foreign-folder', tenant_id: tenant, member_group_id: 'another-group' }];
  assert.equal((await f.request({ action: 'download', resourceId })).code, 404);
  f.tables.file_repository = [];
  assert.equal((await f.request({ action: 'download', resourceId })).code, 404);
  assert.equal(f.signs.length, 0);
});
test('forum author names honor directory opt-outs and tenant boundaries', async () => {
  const f = fixture({ member: [
    { id: 'author', tenant_id: tenant, first_name: 'Visible', last_name: 'Author', show_in_directory: true },
  ] });
  Object.assign(f.tables.forum_post[0], { created_by: 'author', created_by_type: 'member' });
  assert.equal((await f.request({ action: 'thread', threadId })).body.records[0].author_name, 'Visible Author');
  f.tables.member[0].show_in_directory = false;
  assert.equal((await f.request({ action: 'thread', threadId })).body.records[0].author_name, 'Group member');
  f.tables.member[0].show_in_directory = true;
  f.tables.member[0].tenant_id = 'other';
  assert.equal((await f.request({ action: 'thread', threadId })).body.records[0].author_name, 'Group member');
});
test('storage parser rejects substitution, traversal and foreign storage origins', () => {
  for (const target of [
    '/api/storage/secure-url?bucket=private-uploads&path=other/file',
    `/api/storage/secure-url?bucket=private-uploads&path=${tenant}/../file`,
    `https://evil.invalid/storage/v1/object/public/public-assets/${tenant}/file`,
  ]) assert.equal(persistedResourceStorageTarget(target, tenant, 'https://storage.invalid'), null);
});

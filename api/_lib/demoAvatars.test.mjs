// Tests for demo-seeds/avatars.mjs — deterministic storage paths and the
// provenance-safe (fill-null, compare-and-set) profile_photo_url writes.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEMO_AVATAR_BUCKET,
  demoAvatarStoragePath,
  listDemoMembersNeedingAvatars,
  applyDemoMemberAvatar,
  linkExistingDemoAvatars,
} from '../../demo-seeds/avatars.mjs';

const TENANT_ID = 'tenant-demo';

function makeMockSb(state) {
  const writes = [];
  function makeBuilder(table) {
    const filters = {};
    let op = 'select';
    let payload = null;
    const builder = {
      select(cols) { if (op === 'select') filters.__select = cols; return builder; },
      update(row) { op = 'update'; payload = row; return builder; },
      eq(k, v) { filters[k] = v; return builder; },
      is(k, v) { filters[`is:${k}`] = v; return builder; },
      ilike(k, v) { filters[`ilike:${k}`] = v; return builder; },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { return resolve(true); },
      then(res, rej) { return resolve(false).then(res, rej); },
    };
    async function resolve(single) {
      if (op === 'update') {
        writes.push({ table, payload, filters: { ...filters } });
        if (table === 'member' && 'is:profile_photo_url' in filters) {
          const row = state.members.find((m) => m.id === filters.id);
          const matches = row
            && (!('is_sample' in filters) || (row.is_sample ?? false) === filters.is_sample)
            && (row.profile_photo_url ?? null) === filters['is:profile_photo_url'];
          if (matches) row.profile_photo_url = payload.profile_photo_url;
          return { data: matches ? [{ id: row.id }] : [], error: null };
        }
        return { data: null, error: null };
      }
      if (table === 'member') {
        let rows = state.members.filter((m) => (m.tenant_id ?? TENANT_ID) === filters.tenant_id);
        if ('is_sample' in filters) rows = rows.filter((m) => (m.is_sample ?? false) === filters.is_sample);
        if (typeof filters.id === 'string') rows = rows.filter((m) => m.id === filters.id);
        if (filters['ilike:email']) {
          const suffix = filters['ilike:email'].replace(/^%/, '').toLowerCase();
          rows = rows.filter((m) => m.email.toLowerCase().endsWith(suffix));
        }
        if ('is:profile_photo_url' in filters) rows = rows.filter((m) => (m.profile_photo_url ?? null) === filters['is:profile_photo_url']);
        // readPhotoAsNull simulates a stale read racing a concurrent write.
        if (state.readPhotoAsNull && typeof filters.id === 'string') rows = rows.map((m) => ({ ...m, profile_photo_url: null }));
        return { data: single ? (rows[0] || null) : rows, error: null };
      }
      return { data: single ? null : [], error: null };
    }
    return builder;
  }
  const sb = {
    from: (table) => makeBuilder(table),
    storage: {
      from(bucket) {
        assert.equal(bucket, DEMO_AVATAR_BUCKET);
        return {
          async list(prefix, { limit, offset = 0 } = {}) {
            const names = (state.storedPaths || [])
              .filter((p) => p.startsWith(`${prefix}/`))
              .map((p) => ({ name: p.slice(prefix.length + 1) }));
            return { data: names.slice(offset, offset + (limit || 1000)), error: null };
          },
          getPublicUrl(path) { return { data: { publicUrl: `https://cdn.example/${path}` } }; },
        };
      },
    },
  };
  return { sb, writes };
}

test('demoAvatarStoragePath is deterministic, case/whitespace-insensitive on email, tenant-prefixed', () => {
  const a = demoAvatarStoragePath(TENANT_ID, 'jane.doe@aesp.example.com');
  assert.equal(a, demoAvatarStoragePath(TENANT_ID, '  Jane.Doe@AESP.example.com '));
  assert.match(a, new RegExp(`^${TENANT_ID}/[0-9a-f]{40}\\.jpg$`));
  assert.notEqual(a, demoAvatarStoragePath(TENANT_ID, 'other@aesp.example.com'));
  assert.notEqual(a, demoAvatarStoragePath('tenant-2', 'jane.doe@aesp.example.com'));
});

test('listDemoMembersNeedingAvatars: demo-domain + photo-less members only, tenant-scoped', async () => {
  const { sb } = makeMockSb({ members: [
    { id: 'm1', tenant_id: TENANT_ID, is_sample: true, email: 'a@aesp.example.com', profile_photo_url: null },
    { id: 'm2', tenant_id: TENANT_ID, is_sample: true, email: 'b@aesp.example.com', profile_photo_url: 'https://x/p.jpg' },
    { id: 'm3', tenant_id: TENANT_ID, is_sample: true, email: 'real.person@company.co.uk', profile_photo_url: null },
    { id: 'm4', tenant_id: 'other', email: 'c@aesp.example.com', profile_photo_url: null },
  ]});
  const rows = await listDemoMembersNeedingAvatars(sb, TENANT_ID);
  assert.deepEqual(rows.map((r) => r.id), ['m1']);
});

test('non-sample member on the demo domain is neither listed nor writable', async () => {
  const { sb, writes } = makeMockSb({ members: [
    { id: 'm1', tenant_id: TENANT_ID, is_sample: false, email: 'placeholder@aesp.example.com', profile_photo_url: null },
  ]});
  const rows = await listDemoMembersNeedingAvatars(sb, TENANT_ID);
  assert.deepEqual(rows, []);
  await assert.rejects(
    () => applyDemoMemberAvatar({ sb, tenantId: TENANT_ID, memberId: 'm1', url: 'https://cdn.example/x.jpg', log: () => {} }),
    /sample members/,
  );
  assert.equal(writes.length, 0);
});

test('linkExistingDemoAvatars paginates storage listings past 1000 objects', async () => {
  const email = 'deep@aesp.example.com';
  const path = demoAvatarStoragePath(TENANT_ID, email);
  const filler = Array.from({ length: 1000 }, (_, i) => `${TENANT_ID}/filler-${String(i).padStart(4, '0')}.jpg`);
  const { sb } = makeMockSb({
    members: [{ id: 'm1', tenant_id: TENANT_ID, is_sample: true, email, profile_photo_url: null }],
    storedPaths: [...filler, path], // target lands on page 2
  });
  const result = await linkExistingDemoAvatars({ sb, tenantId: TENANT_ID, log: () => {} });
  assert.deepEqual(result, { linked: 1, missing: 0 });
});

test('linkExistingDemoAvatars surfaces storage failures as thrown errors (seed catches + warns)', async () => {
  const { sb } = makeMockSb({ members: [
    { id: 'm1', tenant_id: TENANT_ID, is_sample: true, email: 'a@aesp.example.com', profile_photo_url: null },
  ]});
  sb.storage.from = () => ({ async list() { return { data: null, error: { message: 'Bucket not found' } }; } });
  await assert.rejects(
    () => linkExistingDemoAvatars({ sb, tenantId: TENANT_ID, log: () => {} }),
    /storage list failed: Bucket not found/,
  );
});

test('applyDemoMemberAvatar: fills only a NULL photo; existing photo is never replaced', async () => {
  for (const [existing, expectLinked] of [[null, true], ['https://x/theirs.jpg', false]]) {
    const { sb, writes } = makeMockSb({ members: [
      { id: 'm1', tenant_id: TENANT_ID, is_sample: true, email: 'a@aesp.example.com', profile_photo_url: existing },
    ]});
    const linked = await applyDemoMemberAvatar({ sb, tenantId: TENANT_ID, memberId: 'm1', url: 'https://cdn.example/new.jpg', log: () => {} });
    assert.equal(linked, expectLinked);
    if (existing) assert.equal(writes.length, 0, 'no write when a photo already exists');
    else assert.equal(writes[0].filters['is:profile_photo_url'], null, 'update must carry the IS NULL guard');
  }
});

test('applyDemoMemberAvatar race: photo set between read and write wins (CAS loses gracefully)', async () => {
  const { sb } = makeMockSb({
    members: [{ id: 'm1', tenant_id: TENANT_ID, is_sample: true, email: 'a@aesp.example.com', profile_photo_url: 'https://x/concurrent.jpg' }],
    readPhotoAsNull: true,
  });
  const linked = await applyDemoMemberAvatar({ sb, tenantId: TENANT_ID, memberId: 'm1', url: 'https://cdn.example/new.jpg', log: () => {} });
  assert.equal(linked, false);
});

test('linkExistingDemoAvatars links stored headshots, counts + warns about missing ones, never throws for them', async () => {
  const pathA = demoAvatarStoragePath(TENANT_ID, 'a@aesp.example.com');
  const { sb, writes } = makeMockSb({
    members: [
      { id: 'm1', tenant_id: TENANT_ID, is_sample: true, email: 'a@aesp.example.com', profile_photo_url: null },
      { id: 'm2', tenant_id: TENANT_ID, is_sample: true, email: 'b@aesp.example.com', profile_photo_url: null },
    ],
    storedPaths: [pathA],
  });
  const logs = [];
  const result = await linkExistingDemoAvatars({ sb, tenantId: TENANT_ID, log: (s) => logs.push(s) });
  assert.deepEqual(result, { linked: 1, missing: 1 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].filters.id, 'm1');
  assert.equal(writes[0].payload.profile_photo_url, `https://cdn.example/${pathA}`);
  assert.ok(logs.some((s) => /warning: 1 demo member/.test(s)));
});

test('seed integration: avatar pass is best-effort and fill-null (source contract)', async () => {
  const fs = await import('node:fs');
  const defSrc = fs.readFileSync(new URL('../../demo-seeds/aesp/definition.mjs', import.meta.url), 'utf8');
  assert.match(defSrc, /try \{[\s\S]{0,300}linkExistingDemoAvatars\(\{ sb, tenantId, log \}\)[\s\S]{0,400}catch/,
    'seed must wrap avatar linking in try/catch (warn, never fail the seed)');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveResource } from './entityMeta.js';
import { renderCanvasDynamicBlock } from '../public/prerender.js';

const id = '11111111-1111-4111-8111-111111111111';
const now = Date.parse('2026-11-18T12:00:00Z');
function fixture(patch = {}, failure = null) {
  const calls = [];
  const row = { id, tenant_id: 'tenant', title: 'Public guide', status: 'active',
    is_public: true, release_date: null, ...patch };
  const db = { from(table) {
    let matches = true, single = false;
    const q = {
      select(columns) {
        if (table === 'resource') assert.doesNotMatch(columns, /\b(slug|created_at)\b/);
        return q;
      },
      eq(key, value) {
        calls.push([key, value]);
        if (table === 'resource' && row[key] !== value) matches = false;
        return q;
      },
      or() { return q; },
      order(key) { assert.notEqual(key, 'created_at'); return q; },
      limit() { return q; },
      maybeSingle() { single = true; return q; },
      then(resolve) { resolve({ data: table === 'resource'
        ? (single ? (matches ? row : null) : (matches ? [row] : [])) : [], error: failure }); },
    };
    return q;
  } };
  return { db, calls };
}

test('resource metadata uses IDs, tenant and active status without a slug column', async () => {
  const { db, calls } = fixture();
  const meta = await resolveResource('tenant', id, now, db);
  assert.equal(meta.title, 'Public guide');
  assert.equal(meta.canonicalPath, `/Resources?resourceId=${id}`);
  assert.ok(calls.some(([key, value]) => key === 'tenant_id' && value === 'tenant'));
  assert.ok(calls.some(([key, value]) => key === 'status' && value === 'active'));
  assert.equal(await resolveResource('other-tenant', id, now, db), null);
  assert.equal(await resolveResource('tenant', 'unsupported-slug', now, {
    from() { assert.fail('slug must not issue a query'); },
  }), null);
});

test('resource metadata and crawler previews retain public exclusions', async () => {
  for (const patch of [{ member_group_id: 'group' }, { linked_events: [{ event_id: 'event' }] },
    { release_date: '2099-01-01' }, { status: 'inactive' }]) {
    const { db } = fixture(patch);
    assert.equal(await resolveResource('tenant', id, now, db), null);
    assert.equal(await renderCanvasDynamicBlock(db, { id: 'tenant' }, { type: 'resource-list' }, now), null);
  }
  const { db } = fixture();
  const section = await renderCanvasDynamicBlock(db, { id: 'tenant' }, { type: 'resource-list' }, now);
  assert.match(section.html, /Public guide/);
  const privateFixture = fixture({ is_public: false });
  assert.equal(await renderCanvasDynamicBlock(privateFixture.db, { id: 'tenant' }, { type: 'resource-list' }, now), null);
  // Locked resources retain their public login metadata, not their file target.
  assert.equal((await resolveResource('tenant', id, now, privateFixture.db)).title, 'Public guide');
});

test('metadata database failures are not mistaken for absent resources', async () => {
  const { db } = fixture({}, { code: '08006', message: 'connection lost' });
  await assert.rejects(resolveResource('tenant', id, now, db), { code: '08006' });
});

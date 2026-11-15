import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSessionCategoryIds, resolveSessionCategories, guardGenericSessionCategories, projectPublicSession, listSessionCategories } from './sessionCategories.js';

export const A = '00000000-0000-0000-0000-000000000001';
export const B = '00000000-0000-0000-0000-000000000002';
export const C = '00000000-0000-0000-0000-000000000003';
export const D = '00000000-0000-0000-0000-000000000004';
const categories = [
  { id: A, tenant_id: 'tenant', name: 'First', display_order: 1 },
  { id: B, tenant_id: 'tenant', name: 'Restricted', excluded_role_ids: ['excluded'], display_order: 0 },
  { id: C, tenant_id: 'tenant', name: 'Inactive', is_active: false },
  { id: D, tenant_id: 'other', name: 'Other tenant' },
];
function db(rows = categories, error = null) {
  return { from(table) {
    assert.equal(table, 'resource_category');
    let tenant, ids;
    const q = { select() { return q; }, eq(k, v) { assert.equal(k, 'tenant_id'); tenant = v; return q; },
      in(k, v) { assert.equal(k, 'id'); ids = v; return q; },
      then(resolve) { resolve({ data: rows.filter(c => c.tenant_id === tenant && ids.includes(c.id)), error }); } };
    return q;
  } };
}
test('omitted, empty, deduplicated and valid multi-category assignments', async () => {
  assert.equal(await validateSessionCategoryIds(db(), 'tenant', undefined), undefined);
  assert.deepEqual(await validateSessionCategoryIds(db(), 'tenant', []), []);
  assert.deepEqual(await validateSessionCategoryIds(db(), 'tenant', [A, B, A]), [A, B]);
});
test('reject malformed, null, inactive, missing and cross-tenant IDs', async () => {
  for (const value of [null, '', {}, [null], ['nope'], [C], [D], ['11111111-1111-1111-1111-111111111111']]) {
    await assert.rejects(validateSessionCategoryIds(db(), 'tenant', value), { status: 400 });
  }
  await assert.rejects(validateSessionCategoryIds(db(), 'tenant', [B], [], { isGuest: true }), { status: 400 });
});
test('unavailable old assignments survive unrelated edits and can be cleared', async () => {
  assert.deepEqual(await validateSessionCategoryIds(db([]), 'tenant', [A], [A]), [A]);
  assert.deepEqual(await validateSessionCategoryIds(db(), 'tenant', [C], [C]), [C]);
  assert.deepEqual(await validateSessionCategoryIds(db(), 'tenant', [], [A, C]), []);
});
test('limited editors cannot accidentally clear hidden or unavailable prior assignments', async () => {
  const viewer = {roleId:'excluded'};
  assert.deepEqual(await validateSessionCategoryIds(db(), 'tenant', [A], [A,B,C], viewer), [A,B,C]);
  assert.deepEqual(await validateSessionCategoryIds(db(), 'tenant', [], [A,B,C], viewer), [B,C]);
  assert.deepEqual(await validateSessionCategoryIds(db([]), 'tenant', [], [A], viewer), [A]);
  assert.deepEqual(await validateSessionCategoryIds(db(), 'tenant', undefined, [A,B,C], viewer), undefined);
  assert.deepEqual(await validateSessionCategoryIds(db(), 'tenant', [], [A,B,C], {isPrivileged:true}), []);
});
test('guest, excluded, roleless and allowed viewers get only current safe badges in display order', async () => {
  const sessions = [{ id: 'session', category_ids: [A, B, C, D] }, { id: 'legacy' }];
  for (const viewer of [{ isGuest: true }, { roleId: 'excluded' }, {}]) {
    const result = await resolveSessionCategories(db(), 'tenant', sessions, viewer);
    assert.deepEqual(result[0].categories, [{ id: A, name: 'First' }]);
    assert.equal('category_ids' in result[0], false);
    assert.deepEqual(result[1].categories, []);
    assert.ok(!JSON.stringify(result).includes('excluded_role_ids'));
  }
  const [allowed] = await resolveSessionCategories(db(), 'tenant', sessions, { roleId: 'allowed' }, { keepIds: true });
  assert.deepEqual(allowed.category_ids, [B, A]);
  assert.deepEqual(allowed.categories.map(c => c.name), ['Restricted', 'First']);
  const [renamed] = await resolveSessionCategories(db([{ ...categories[0], name: 'Renamed' }]), 'tenant', sessions);
  assert.equal(renamed.categories[0].name, 'Renamed');
  assert.deepEqual((await resolveSessionCategories(db([]), 'tenant', sessions))[0].categories, []);
});
test('policy failures fail closed and public projection removes host URLs and access metadata', async () => {
  await assert.rejects(resolveSessionCategories(db([], new Error('unavailable')), 'tenant', [{ category_ids: [A] }]));
  assert.deepEqual(projectPublicSession({ id: 's', title: 'Title', zoom_start_url: 'private', teams_join_web_url: 'private', tenant_id: 'tenant', excluded_role_ids: ['r'], category_ids: [A] }),
    { id: 's', title: 'Title', category_ids: [A] });
});
test('generic category projection and inference routes are closed and response IDs stripped', () => {
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  for (const query of [{ expand: 'renamed:category_ids' }, { filter: '{"category_ids":["secret"]}' }, { sort: '{"category_ids":"asc"}' }]) {
    assert.equal(guardGenericSessionCategories({ query }, res, 'complexeventsession'), true);
    assert.equal(res.code, 400);
  }
  assert.equal(guardGenericSessionCategories({ query: { expand: 'complex_event_session(*)' } }, res, 'complexevent'), true);
  assert.equal(guardGenericSessionCategories({ query: {} }, res, 'complexeventsession'), false);
  res.json({ data: [{ id: 's', category_ids: [B] }], count: 1 });
  assert.deepEqual(res.body, { data: [{ id: 's' }], count: 1 });
});

test('catalogue reads past a full hidden page and strips policies before responding', async () => {
  const offsets = [];
  const hidden = Array.from({length: 500}, (_, i) => ({ id: `hidden-${i}`, name: 'Hidden', excluded_role_ids: ['r'] }));
  const database = { from() {
    const q = { select() { return q; }, eq(k,v) { assert.equal(v, 'tenant'); return q; }, order() { return q; },
      range(start) { offsets.push(start); return Promise.resolve({data:start===0?hidden:[categories[0]],error:null}); } };
    return q;
  }};
  assert.deepEqual(await listSessionCategories(database, 'tenant', {isGuest:true}),
    [{id:A,name:'First',display_order:1,is_active:undefined}]);
  assert.deepEqual(offsets,[0,500]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlphabetFilterRecorder } from './crmAlphabetQuery.js';
import { parseMemberListFilters, applyMemberListFilters } from './memberListFilters.js';
import { memberAlphabetRecorder } from './crmAlphabet.js';
import { requireCrmListAccess } from './crmListAccess.js';
import { __setRoleAccessOverlayForTests } from './roleVisibility.js';
__setRoleAccessOverlayForTests([]);

test('existing filters record tenant scope, negative and linked joins without reading rows', () => {
  const ctx = parseMemberListFilters({
    search: 'Ada Love', roleId: 'r1,r2', status: 'active',
    customFilters: JSON.stringify({ f: { op: 'none_of', value: ['A,"quoted"', '100%'] } }),
    organizationFilters: JSON.stringify({ of: ['x'] }),
  });
  const q = memberAlphabetRecorder(ctx);
  q.eq('tenant_id', 't');
  applyMemberListFilters(q, ctx, { tenantId: 't' });
  const tree = q.result();
  assert.equal(tree.joins.cf0.negative, true);
  assert.equal(tree.joins.cf0.filters[1].or[0].value, 'A,"quoted"');
  assert.equal(tree.joins['orgf0.opv0'].filters[0].value, 'of');
  assert.equal(tree.base.filter(n => n.or).length, 2);
});
test('recorder preserves PostgREST star rewriting, nulls, lists and rejects malformed grammar', () => {
  const q = createAlphabetFilterRecorder();
  q.or('mobile.is.null,mobile.not.in.("a,b","c")').ilike('name', '*_x%');
  assert.deepEqual(q.result().base[0].or[1].value, ['a,b','c']);
  assert.equal(q.result().base[1].value, '%_x%');
  assert.throws(() => q.or('name.eq."unterminated'), /Invalid/);
  assert.throws(() => q.or('name.gt.1'), /Invalid/);
});
function permissionDb(exclusions = [], overlay = []) {
  return { from(table) {
    const q = { select() { return q; }, eq() { return q; }, single() { return q; },
      then(resolve) { return Promise.resolve({ data: table === 'role' ? { excluded_features: exclusions } : overlay, error: null }).then(resolve); } };
    return q;
  } };
}
const portal = { isAuthenticated: true, tenantId: 't', memberId: 'm', roleId: 'r' };
test('page and metadata authority preserves admin and portal access, denies missing roles and exclusions', async () => {
  await requireCrmListAccess(null, { isAuthenticated: true, tenantId: 't', tenantUserId: 'a' }, 'crm.members');
  await requireCrmListAccess(permissionDb(), portal, 'crm.members');
  for (const context of [{}, { ...portal, tenantMismatch: true }, { ...portal, roleId: null }]) {
    await assert.rejects(requireCrmListAccess(permissionDb(), context, 'crm.members'));
  }
  for (const exclusions of [['crm'], ['page_MembersList'], ['crm.members']]) {
    await assert.rejects(requireCrmListAccess(permissionDb(exclusions), portal, 'crm.members'), /Forbidden/);
  }
  await assert.rejects(requireCrmListAccess(permissionDb(), { ...portal, memberExcludedFeatures: ['crm.organisations'] }, 'crm.organisations'), /Forbidden/);
});
test('DB overlay adds restrictions without replacing canonical parent restrictions', async () => {
  const rows = [{ id: 'module', item_key: 'extra', item_type: 'module' },
    { id: 'page', item_key: 'crm.members', item_type: 'page', parent_id: 'module' }];
  await assert.rejects(requireCrmListAccess(permissionDb(['extra'], rows), portal, 'crm.members'), /Forbidden/);
  await assert.rejects(requireCrmListAccess(permissionDb(['crm'], rows), portal, 'crm.members'), /Forbidden/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRows, classify, matchesRequested, TENANT, ROLE } from './import-gfi-ahecs-members.mjs';

const fixture = () => Array.from({ length: 17 }, (_, i) => ({
  first_name: 'Example', last_name: `Person ${i}`, email: ` EXAMPLE${i}@example.test `,
  organisation_id: `00000000-0000-4000-a000-${String(i % 11).padStart(12, '0')}`,
  organisation_name: `Organisation ${i % 11}`,
}));
test('normalizes emails, maps UUIDs, and gives stable import identities', () => {
  const rows = validateRows(fixture());
  assert.equal(rows[0].email, 'example0@example.test');
  assert.equal(rows[0].organization_id, fixture()[0].organisation_id);
  assert.deepEqual(rows, validateRows(fixture()));
});
test('rejects duplicate normalized emails, missing names, bad UUIDs and wrong counts', () => {
  const duplicate = fixture(); duplicate[1].email = duplicate[0].email.toLowerCase();
  assert.throws(() => validateRows(duplicate), /DUPLICATE_EMAIL/);
  const blank = fixture(); blank[0].first_name = '';
  assert.throws(() => validateRows(blank), /INVALID_CELL/);
  const badId = fixture(); badId[0].organisation_id = 'not-a-uuid';
  assert.throws(() => validateRows(badId), /INVALID_ORGANIZATION_ID/);
  assert.throws(() => validateRows(fixture().slice(1)), /EXPECTED_17_ROWS/);
});
test('preserves existing accounts and blocks ambiguous, cross-tenant and label mismatches', () => {
  const rows = validateRows(fixture());
  const orgs = rows.map(r => ({ id: r.organization_id, name: r.organization_name, tenant_id: TENANT }));
  const existing = { id: 'existing', email: rows[0].email.toUpperCase() };
  assert.equal(classify(rows, [existing], orgs)[0].action, 'already-present');
  assert.equal(classify(rows, [existing, { ...existing, id: 'other' }], orgs)[0].reason, 'ambiguous-email');
  assert.equal(classify(rows, [], [])[0].reason, 'invalid-organization');
  assert.equal(classify(rows, [], orgs.map(o => ({ ...o, tenant_id: 'other' })))[0].reason, 'invalid-organization');
  assert.equal(classify(rows, [], orgs.map(o => ({ ...o, name: 'different' })))[0].reason, 'organization-label-mismatch');
});
test('verification requires exact identity, role, organization and explicit flags', () => {
  const r = validateRows(fixture())[0];
  const member = { ...r, tenant_id: TENANT, role_id: ROLE, login_enabled: true,
    show_in_directory: false, is_guest: false, status: 'active', organization_group_id: null };
  assert.equal(matchesRequested(r, member), true);
  for (const [key, value] of Object.entries({ tenant_id: 'other', role_id: 'other', organization_id: 'other',
    email: 'other@example.test', first_name: 'Other', login_enabled: false, show_in_directory: true,
    is_guest: true, status: 'inactive', organization_group_id: 'group' })) {
    assert.equal(matchesRequested(r, { ...member, [key]: value }), false, key);
  }
});
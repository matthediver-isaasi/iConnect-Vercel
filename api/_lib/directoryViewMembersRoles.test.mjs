import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoleIdArray, resolveOrgViewMembersRoleIds } from './directoryConfig.js';

function fakeSupabase(settingValue) {
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        limit: async () => ({ data: settingValue === undefined ? [] : [{ setting_value: settingValue }] }),
      };
    },
  };
}

test('dynamic override distinguishes inherit, empty, and selected roles', async () => {
  const db = fakeSupabase('["legacy-contact"]');
  assert.deepEqual(await resolveOrgViewMembersRoleIds(db, 't1', { id: 'd1', view_members_role_ids: null }), ['legacy-contact']);
  assert.deepEqual(await resolveOrgViewMembersRoleIds(db, 't1', { id: 'd1', view_members_role_ids: [] }), []);
  assert.deepEqual(await resolveOrgViewMembersRoleIds(db, 't1', { id: 'd1', view_members_role_ids: ['member'] }), ['member']);
});

test('standard directory always uses tenant View Members setting', async () => {
  const db = fakeSupabase('["tenant-role"]');
  assert.deepEqual(await resolveOrgViewMembersRoleIds(db, 't1', { id: 'main', view_members_role_ids: ['ignored'] }), ['tenant-role']);
});

test('missing or malformed role policy fails closed', () => {
  assert.deepEqual(parseRoleIdArray(undefined), []);
  assert.deepEqual(parseRoleIdArray('{bad json'), []);
  assert.deepEqual(parseRoleIdArray(['ok', '', null, 4]), ['ok']);
});
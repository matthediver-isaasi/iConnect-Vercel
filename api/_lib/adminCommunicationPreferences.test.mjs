import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeCommunicationPreferencesAdmin,
  loadAdminMemberCommunicationPreferences,
  setAdminMemberCommunicationGlobalState,
} from './adminCommunicationPreferences.js';

function databaseFixture() {
  const rows = {
    member: [
      { id: 'member-a', tenant_id: 'tenant-a', email: 'a@example.com', role_id: 'role-a', communications_opted_out_all: false },
      { id: 'member-b', tenant_id: 'tenant-b', email: 'b@example.com', role_id: 'role-b', communications_opted_out_all: false },
    ],
    communication_category: [
      { id: 'open', tenant_id: 'tenant-a', name: 'Open', display_order: 1, is_active: true },
      { id: 'matching', tenant_id: 'tenant-a', name: 'Matching', display_order: 2, is_active: true },
      { id: 'other-role', tenant_id: 'tenant-a', name: 'Other', display_order: 3, is_active: true },
      { id: 'inactive', tenant_id: 'tenant-a', name: 'Inactive', display_order: 4, is_active: false },
    ],
    communication_category_role: [
      { tenant_id: 'tenant-a', category_id: 'matching', role_id: 'role-a' },
      { tenant_id: 'tenant-a', category_id: 'other-role', role_id: 'role-b' },
    ],
    member_communication_preference: [
      { tenant_id: 'tenant-a', member_id: 'member-a', category_id: 'matching', is_subscribed: true },
    ],
  };

  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      rows.member[0].communications_opted_out_all = args.p_opt_out_all;
      for (const categoryId of args.p_category_ids) {
        const existing = rows.member_communication_preference.find((preference) =>
          preference.member_id === args.p_member_id && preference.category_id === categoryId);
        if (existing) existing.is_subscribed = false;
        else rows.member_communication_preference.push({
          tenant_id: args.p_tenant_id,
          member_id: args.p_member_id,
          category_id: categoryId,
          is_subscribed: false,
        });
      }
      return { error: null };
    },
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        order() { return Promise.resolve(result()); },
        maybeSingle() {
          const data = result().data;
          return Promise.resolve({ data: data[0] || null, error: null });
        },
        then(resolve) { return Promise.resolve(result()).then(resolve); },
      };
      function result() {
        return {
          data: (rows[table] || []).filter((row) =>
            filters.every(([column, value]) => row[column] === value)),
          error: null,
        };
      }
      return query;
    },
  };
}

test('admin authorization rejects unauthenticated and unauthorized members', async () => {
  const unauthenticated = await authorizeCommunicationPreferencesAdmin({}, {
    getTenantContext: async () => ({ isAuthenticated: false }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => false,
  });
  assert.equal(unauthenticated.status, 401);

  const forbidden = await authorizeCommunicationPreferencesAdmin({}, {
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', roleId: 'role-a' }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => false,
  });
  assert.equal(forbidden.status, 403);
});

test('admin authorization accepts tenant administrators and communication managers', async () => {
  const admin = await authorizeCommunicationPreferencesAdmin({}, {
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a' }),
    hasAdminAccess: async () => true,
    hasFeatureAccess: async () => false,
  });
  assert.equal(admin.context.tenantId, 'tenant-a');

  const manager = await authorizeCommunicationPreferencesAdmin({}, {
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', roleId: 'manager' }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async (roleId, feature) =>
      roleId === 'manager' && feature === 'admin_can_manage_communications',
  });
  assert.equal(manager.context.tenantId, 'tenant-a');
});

test('admin preference response includes unrestricted and matching active categories with current state', async () => {
  const result = await loadAdminMemberCommunicationPreferences(databaseFixture(), {
    tenantId: 'tenant-a',
    memberId: 'member-a',
  });

  assert.deepEqual(result.categories.map(({ id }) => id), ['open', 'matching']);
  assert.equal(result.categories.find(({ id }) => id === 'open').isSubscribed, false);
  assert.equal(result.categories.find(({ id }) => id === 'matching').isSubscribed, true);
});

test('admin preference response cannot read a member from another tenant', async () => {
  const result = await loadAdminMemberCommunicationPreferences(databaseFixture(), {
    tenantId: 'tenant-a',
    memberId: 'member-b',
  });
  assert.equal(result, null);
});

test('admin global opt-out uses the atomic server RPC and returns immediate authoritative state', async () => {
  const database = databaseFixture();
  const result = await setAdminMemberCommunicationGlobalState(database, {
    tenantId: 'tenant-a',
    memberId: 'member-a',
    optOutAll: true,
  });

  assert.equal(result.optedOutAll, true);
  assert.deepEqual(result.categories.map(({ isSubscribed }) => isSubscribed), [false, false]);
  assert.deepEqual(database.calls[0], {
    name: 'set_email_preference_global_state',
    args: {
      p_tenant_id: 'tenant-a',
      p_email: 'a@example.com',
      p_member_id: 'member-a',
      p_opt_out_all: true,
      p_campaign_id: null,
      p_category_ids: ['open', 'matching'],
    },
  });
});
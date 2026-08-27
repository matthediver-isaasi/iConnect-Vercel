import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAdminCommunicationPreferenceUpdate } from './[categoryId].js';

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function databaseFixture({ existing = null } = {}) {
  const writes = [];
  return {
    writes,
    from(table) {
      let writeValue = null;
      const query = {
        select() { return query; },
        eq() { return query; },
        single() {
          if (writeValue) {
            return Promise.resolve({ data: { id: 'saved-preference', ...writeValue }, error: null });
          }
          return Promise.resolve({ data: existing, error: existing ? null : { code: 'PGRST116' } });
        },
        update(value) {
          writeValue = value;
          writes.push({ operation: 'update', table, value });
          return query;
        },
        insert(value) {
          writeValue = value;
          writes.push({ operation: 'insert', table, value });
          return query;
        },
      };
      return query;
    },
  };
}

const authorization = {
  getTenantContext: async () => ({
    isAuthenticated: true,
    tenantId: 'tenant-a',
    tenantUserId: 'admin-a',
  }),
  hasAdminAccess: async () => true,
  hasFeatureAccess: async () => false,
};

function eligibility(eligibleCategoryIds) {
  return async () => ({
    member: { id: 'member-a', tenant_id: 'tenant-a' },
    allCategories: [{ id: 'category-a' }],
    eligibleCategories: eligibleCategoryIds.has('category-a') ? [{ id: 'category-a' }] : [],
    eligibleCategoryIds,
  });
}

async function invoke({ isSubscribed, eligible, existing = null }) {
  const database = databaseFixture({ existing });
  const res = responseRecorder();
  await handleAdminCommunicationPreferenceUpdate({
    method: 'PATCH',
    query: { memberId: 'member-a', categoryId: 'category-a' },
    body: { is_subscribed: isSubscribed },
    headers: {},
  }, res, {
    ...authorization,
    database,
    loadMemberCommunicationCategoryEligibility: eligibility(
      eligible ? new Set(['category-a']) : new Set(),
    ),
  });
  return { database, res };
}

test('admin cannot subscribe a member to a category outside role eligibility', async () => {
  const { database, res } = await invoke({ isSubscribed: true, eligible: false });
  assert.equal(res.statusCode, 403);
  assert.equal(database.writes.length, 0);
});

test('admin can subscribe a member to an eligible category', async () => {
  const { database, res } = await invoke({ isSubscribed: true, eligible: true });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(database.writes[0], {
    operation: 'insert',
    table: 'member_communication_preference',
    value: {
      member_id: 'member-a',
      category_id: 'category-a',
      is_subscribed: true,
      tenant_id: 'tenant-a',
    },
  });
});

test('admin can unsubscribe an existing preference after role eligibility is removed', async () => {
  const { database, res } = await invoke({
    isSubscribed: false,
    eligible: false,
    existing: { id: 'preference-a' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(database.writes[0], {
    operation: 'update',
    table: 'member_communication_preference',
    value: {
      is_subscribed: false,
      updated_at: database.writes[0].value.updated_at,
    },
  });
  assert.match(database.writes[0].value.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});
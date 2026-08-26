import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePreferenceUpdate } from './index.js';

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createDatabase({ rpcError = null, memberPreferences = [], external = false } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      return { error: rpcError };
    },
    from(table) {
      const query = {
        select() { return query; },
        eq() { return query; },
        ilike() { return query; },
        in() { return query; },
        then(resolve) {
          if (table === 'member_communication_preference') {
            return resolve({ data: memberPreferences, error: null });
          }
          if (table === 'email_subscriber' && external) {
            return resolve({
              data: [{ id: 'subscriber-1', communication_category_id: 'category-1', opted_out: true }],
              error: null,
            });
          }
          if (table === 'email_unsubscribe' && external) {
            return resolve({
              data: [
                { unsubscribe_type: 'all', communication_category_id: null },
                { unsubscribe_type: 'category', communication_category_id: 'category-1' },
              ],
              error: null,
            });
          }
          return resolve({ data: [], error: null });
        },
      };
      return query;
    },
  };
}

const category = { id: 'category-1', name: 'News' };

test('member global opt-out uses the atomic RPC and returns persisted category state', async () => {
  const database = createDatabase({
    memberPreferences: [{ category_id: category.id, is_subscribed: false }],
  });
  const res = responseRecorder();

  await handlePreferenceUpdate(
    { body: { action: 'toggle_all', optOutAll: true } },
    res,
    {
      database,
      member: { id: 'member-1', email: 'Member@Example.com' },
      recipient: { email: 'old@example.com' },
      campaign: { id: 'campaign-1' },
      categories: [category],
      tenantId: 'tenant-1',
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.optedOutAll, true);
  assert.equal(res.body.categories[0].isSubscribed, false);
  assert.deepEqual(database.calls[0], {
    name: 'set_email_preference_global_state',
    args: {
      p_tenant_id: 'tenant-1',
      p_email: 'Member@Example.com',
      p_member_id: 'member-1',
      p_opt_out_all: true,
      p_campaign_id: 'campaign-1',
      p_category_ids: ['category-1'],
    },
  });
});

test('external global opt-out refreshes null-category global ledger state', async () => {
  const database = createDatabase({ external: true });
  const res = responseRecorder();

  await handlePreferenceUpdate(
    { body: { action: 'toggle_all', optOutAll: true } },
    res,
    {
      database,
      member: null,
      recipient: { email: 'External@Example.com' },
      campaign: { id: 'campaign-1' },
      categories: [category],
      tenantId: 'tenant-1',
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.optedOutAll, true);
  assert.equal(database.calls[0].args.p_member_id, null);
  assert.equal(database.calls[0].args.p_email, 'External@Example.com');
});

test('database failures are logged with diagnostics but return a safe retry response', async () => {
  const database = createDatabase({
    rpcError: {
      code: '42P10',
      message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
      details: 'database-only detail',
      hint: 'database-only hint',
    },
  });
  const res = responseRecorder();
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    await handlePreferenceUpdate(
      { body: { action: 'toggle_all', optOutAll: true } },
      res,
      {
        database,
        member: { id: 'member-1', email: 'member@example.com' },
        recipient: { email: 'member@example.com' },
        campaign: null,
        categories: [category],
        tenantId: 'tenant-1',
      },
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    success: false,
    error: 'Email preferences are temporarily unavailable. Please try again.',
  });
  assert.equal(JSON.stringify(res.body).includes('42P10'), false);
  assert.equal(logs[0][1].operation, 'set_global_state');
  assert.equal(logs[0][1].code, '42P10');
  assert.equal(logs[0][1].details, 'database-only detail');
});
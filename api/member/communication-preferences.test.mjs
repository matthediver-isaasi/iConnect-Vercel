import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMemberCommunicationPreferences } from './communication-preferences.js';

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function preferenceDatabase(preferences = []) {
  const calls = [];
  return {
    calls,
    from(table) {
      const query = {
        select() { return query; },
        eq() { return query; },
        upsert(value) { calls.push({ table, value }); return Promise.resolve({ error: null }); },
        then(resolve) {
          return Promise.resolve({ data: table === 'member_communication_preference' ? preferences : [], error: null }).then(resolve);
        },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      return { error: null };
    },
  };
}

const sessionMember = { id: 'member-a', tenant_id: 'tenant-a' };
const eligibility = {
  member: { ...sessionMember, email: 'a@example.com', communications_opted_out_all: false },
  allCategories: [
    { id: 'open', name: 'Open' },
    { id: 'matching', name: 'Matching' },
    { id: 'other-role', name: 'Other role' },
  ],
  eligibleCategories: [
    { id: 'open', name: 'Open' },
    { id: 'matching', name: 'Matching' },
  ],
  eligibleCategoryIds: new Set(['open', 'matching']),
};

const dependencies = (database) => ({
  database,
  getSessionMember: async () => sessionMember,
  loadMemberCommunicationCategoryEligibility: async (_database, args) => {
    assert.deepEqual(args, { tenantId: 'tenant-a', memberId: 'member-a' });
    return eligibility;
  },
});

test('self-service read is bound to the signed-in member and returns only eligible categories', async () => {
  const res = responseRecorder();
  await handleMemberCommunicationPreferences(
    { method: 'GET' },
    res,
    dependencies(preferenceDatabase([{ category_id: 'matching', is_subscribed: true }])),
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.categories.map(({ id }) => id), ['open', 'matching']);
  assert.equal(res.body.categories[1].isSubscribed, true);
});

test('self-service cannot subscribe to a category outside current eligibility', async () => {
  const database = preferenceDatabase();
  const res = responseRecorder();
  await handleMemberCommunicationPreferences(
    { method: 'PATCH', body: { categoryId: 'other-role', isSubscribed: true } },
    res,
    dependencies(database),
  );

  assert.equal(res.statusCode, 403);
  assert.equal(database.calls.length, 0);
});

test('self-service can unsubscribe from a known category after eligibility is removed', async () => {
  const database = preferenceDatabase([{ category_id: 'other-role', is_subscribed: true }]);
  const res = responseRecorder();
  await handleMemberCommunicationPreferences(
    { method: 'PATCH', body: { categoryId: 'other-role', isSubscribed: false } },
    res,
    dependencies(database),
  );

  assert.equal(res.statusCode, 200);
  assert.equal(database.calls[0].value.member_id, 'member-a');
  assert.equal(database.calls[0].value.is_subscribed, false);
});
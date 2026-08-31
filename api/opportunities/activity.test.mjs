import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunityActivityHandler } from './activity.js';

function response() {
  return { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function contactFeedDb() {
  const calls = [];
  const rows = {
    opportunity_contact_role: [{ opportunity_id: 'opp-contact' }],
    opportunity_activity: [
      { opportunity_id: 'opp-contact', action: 'opportunity.created' },
      { opportunity_id: 'opp-contact', action: 'opportunity.updated' },
      { opportunity_id: 'opp-contact', action: 'stage.changed' },
    ],
  };
  return {
    calls,
    from(table) {
      const call = { table, filters: [] }; calls.push(call);
      const chain = {
        select() { return chain; },
        eq(key, value) { call.filters.push(['eq', key, value]); return chain; },
        in(key, value) { call.filters.push(['in', key, value]); return chain; },
        order() { return chain; },
        range() { return Promise.resolve({ data: rows[table] || [], count: (rows[table] || []).length, error: null }); },
        then(resolve) { return Promise.resolve({ data: rows[table] || [], error: null }).then(resolve); },
      };
      return chain;
    },
  };
}

test('contact activity API scopes created, updated and stage activity through tenant contact roles', async () => {
  const db = contactFeedDb();
  const handler = createOpportunityActivityHandler({
    db,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'admin-a' }),
    hasAdminAccess: async () => true,
  });
  const res = response();
  await handler({ method: 'GET', query: { memberId: 'member-a' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items.map((item) => item.action),
    ['opportunity.created', 'opportunity.updated', 'stage.changed']);
  const roles = db.calls.find((call) => call.table === 'opportunity_contact_role');
  assert.deepEqual(roles.filters, [['eq', 'tenant_id', 'tenant-a'], ['eq', 'member_id', 'member-a']]);
  const activity = db.calls.find((call) => call.table === 'opportunity_activity');
  assert.ok(activity.filters.some((filter) => filter[0] === 'in'
    && filter[1] === 'opportunity_id' && filter[2].includes('opp-contact')));
  assert.ok(activity.filters.some((filter) => filter[1] === 'tenant_id' && filter[2] === 'tenant-a'));
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleProgramEntitlementEntity } from './programEntitlementBoundary.js';
import { quoteProgramPurchase } from './programVoucherPurchase.js';

test('programme history scopes personal and organization ownership from the session', async () => {
  const calls = [];
  const query = {
    select(...args) { calls.push(['select', ...args]); return this; },
    eq(...args) { calls.push(['eq', ...args]); return this; },
    or(...args) { calls.push(['or', ...args]); return this; },
    order() { return this; }, limit() { return Promise.resolve({ data: [] }); },
  };
  let status;
  const context = { isAuthenticated: true, tenantId: 'tenant',
    memberId: '00000000-0000-0000-0000-000000000001', organizationId: '00000000-0000-0000-0000-000000000002' };
  await handleProgramEntitlementEntity({ entity: 'programtickettransaction', req: { method: 'GET', query: {} },
    res: { status(value) { status = value; return this; }, json() {} }, context,
    db: { from() { return query; } }, hasAdminAccess: async () => false });
  assert.equal(status, 200);
  assert.deepEqual(calls.find(row => row[0] === 'eq'), ['eq', 'tenant_id', 'tenant']);
  assert.deepEqual(calls.find(row => row[0] === 'or'), ['or',
    `owner_member_id.eq.${context.memberId},organization_id.eq.${context.organizationId}`]);
});

test('programme history rejects unauthenticated reads and non-admin ledger writes', async () => {
  for (const [context, method] of [[{}, 'GET'], [{ isAuthenticated: true, tenantId: 'tenant' }, 'POST']]) {
    let status;
    await handleProgramEntitlementEntity({ entity: 'programtickettransaction', req: { method, query: {} }, context,
      res: { status(value) { status = value; return this; }, json() {} },
      db: { from() { throw new Error('must not query'); } }, hasAdminAccess: async () => false });
    assert.equal(status, 403);
  }
});

test('programme quote permits a no-organization member and disallows training funds', async () => {
  const db = { from(table) {
    const query = { select() { return this; }, eq() { return this; },
      single: async () => ({ data: table === 'member'
        ? { id: 'member', tenant_id: 'tenant', email: 'member@example.invalid', organization_id: null }
        : { id: 'program', name: 'Programme', program_tag: 'tag', program_ticket_price: 10 } }) };
    return query;
  } };
  const params = { programId: 'program', quantity: 2, selectedVoucherIds: [] };
  const quote = await quoteProgramPurchase(db, { tenantId: 'tenant', memberId: 'member', params });
  assert.equal(quote.organizationId, null);
  assert.equal(quote.tickets, 2);
  assert.equal(quote.remainingMinor, 2000);
  await assert.rejects(quoteProgramPurchase(db, { tenantId: 'tenant', memberId: 'member',
    params: { ...params, trainingFundAmount: 1 } }), /require an organization/);
});

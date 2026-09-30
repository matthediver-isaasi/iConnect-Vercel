import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSalesAllocationsHandler } from './[...path].js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const memberId = '10000000-0000-4000-8000-000000000001';
const grantedId = '20000000-0000-4000-8000-000000000001';
const otherId = '30000000-0000-4000-8000-000000000001';

function response() {
  return {
    statusCode: 0, body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function grantQuery(granted = true) {
  return {
    select() { return this; }, eq() { return this; }, is() { return this; },
    async maybeSingle() { return { data: granted ? { id: 'grant-1' } : null, error: null }; },
  };
}

function handlerForMember() {
  const calls = [];
  const db = {
    from(table) {
      if (table === 'sales_commercial_allocation_manager') return grantQuery(true);
      // GET detail resolves several independent read queries. They only need
      // a safe empty result for this authorization-focused test.
      return { select() { return this; }, eq() { return this; }, order() { return this; }, maybeSingle: async () => ({ data: table === 'sales_commercial_allocation' ? { id: grantedId } : null, error: null }) };
    },
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === 'reserve_sales_allocation_invitation') return { data: { invitationId: 'invite-1', expiresAt: args.p_expires_at }, error: null };
      return { data: { released: true }, error: null };
    },
  };
  return {
    calls,
    handler: createSalesAllocationsHandler({
      db,
      getTenantContext: async () => ({ isAuthenticated: true, tenantId, memberId }),
      // A globally denied Sales capability must never be consulted for member
      // grant actions.
      hasFeatureAccess: async () => false,
      getPublicAllocationInvitationContext: async () => ({
        tenantId, eventKind: 'simple', eventId: 'event-1', eventSlug: 'event',
        eventName: 'Event', ticketTypeId: 'ticket', ticketName: 'Ticket',
        organizationId: 'org', organizationName: 'Org', delegateEmail: 'd@example.test',
      }),
      getTrustedBaseUrlForTenant: async () => 'https://tenant.example',
      sendEmail: async () => ({ success: true }),
    }),
  };
}

test('member without global Sales access can invite only through their explicit grant', async () => {
  const { handler, calls } = handlerForMember();
  const res = response();
  await handler({
    method: 'POST', query: { path: [grantedId, 'invite'] },
    body: { email: 'd@example.test', expiresAt: '2030-01-01T00:00:00.000Z', idempotencyKey: 'invite' },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(calls[0][0], 'reserve_sales_allocation_invitation');
});

test('member cannot invoke commercial lifecycle or grant actions', async () => {
  for (const action of ['release', 'cancel', 'reconcile', 'grant-manager']) {
    const { handler, calls } = handlerForMember();
    const res = response();
    await handler({ method: 'POST', query: { path: [grantedId, action] }, body: {} }, res);
    assert.equal(res.statusCode, 403, action);
    assert.equal(calls.length, 0, action);
  }
});

test('member cannot access another allocation even when authenticated', async () => {
  const { handler } = handlerForMember();
  // Override grant lookup for the other allocation by using a standalone
  // handler with an absent manager row.
  const db = { from: () => grantQuery(false) };
  const denied = createSalesAllocationsHandler({
    db,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId, memberId }),
  });
  const res = response();
  await denied({ method: 'GET', query: { path: [otherId] } }, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /Allocation not found/);
  assert.ok(handler);
});

test('member detail route uses the least-privilege projection, not admin detail', async () => {
  const source = await readFile(fileURLToPath(new URL('./[...path].js', import.meta.url)), 'utf8');
  assert.match(source, /getManagerAllocationDetail\(db, actor\.tenantId, id, managerGrant\.id\)/);
  const projection = await readFile(fileURLToPath(new URL('../../_lib/salesCommercialAllocation.js', import.meta.url)), 'utf8');
  const start = projection.indexOf('export async function getManagerAllocationDetail');
  const end = projection.indexOf('\nexport ', start + 1);
  const body = projection.slice(start, end === -1 ? undefined : end);
  assert.doesNotMatch(body, /sales_commercial_sale|\bmovements\b|\bmanagers\b/);
  assert.match(body, /eq\('manager_id', managerId\)/);
  assert.match(body, /delegate_name/);
});
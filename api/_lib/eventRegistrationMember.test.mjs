import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedMemberInput, makeEventRegistrationMemberHandler } from './eventRegistrationMember.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const body = { bookingId: tenantId, isComplex: false, first_name: ' Test ', last_name: ' Member ',
  email: 'Test@Example.invalid', role_id: tenantId, organization_id: null };
test('reviewed fields are bounded and normalized without inferring organisation', () => {
  const result = reviewedMemberInput(body);
  assert.equal(result.email, 'test@example.invalid');
  assert.equal(result.first_name, 'Test');
  assert.equal(result.organization_id, null);
  for (const patch of [{ isComplex: 'anything' }, { email: 'bad' }, { role_id: null },
    { first_name: '' }, { last_name: 'a'.repeat(251) }, { organization_id: 'bad' },
    { role_effective_from: '2026-02-30' }, { supplied_organization_name: {} }]) {
    assert.throws(() => reviewedMemberInput({ ...body, ...patch }));
  }
});
async function request(overrides = {}, req = { method: 'POST', body }) {
  const calls = [];
  const handler = makeEventRegistrationMemberHandler({
    db: { rpc: async (name, args) => { calls.push({ name, args }); return { data: { member: { id: tenantId }, alreadyLinked: false } }; } },
    getContext: async () => ({ tenantId, isAuthenticated: true, roleId: tenantId }),
    adminAccess: async () => true, featureAccess: async () => true, ...overrides,
  });
  let status = 200, payload;
  await handler(req, { status(value) { status = value; return this; }, json(value) { payload = value; } });
  return { status, payload, calls };
}
test('server-selected tenant and reviewed input alone reach atomic RPC', async () => {
  const r = await request({}, { method: 'POST', body: { ...body, tenant_id: 'attacker', login_enabled: false, payment_method: 'free' } });
  assert.equal(r.status, 200);
  assert.equal(r.calls[0].args.p_tenant_id, tenantId);
  assert.equal(r.calls[0].args.p_email, 'test@example.invalid');
  assert.equal('payment_method' in r.calls[0].args, false);
});
test('authentication, tenant mismatch, group-admin and role-management denials never write', async () => {
  for (const [override, status] of [
    [{ getContext: async () => null }, 401],
    [{ getContext: async () => ({ tenantId, isAuthenticated: true, tenantMismatch: true }) }, 409],
    [{ adminAccess: async () => false }, 403],
    [{ featureAccess: async (_, feature) => feature !== 'admin.role-management' }, 403],
    [{ featureAccess: async (_, feature) => feature !== 'events.event-report' }, 403],
  ]) {
    const r = await request(override);
    assert.equal(r.status, status); assert.equal(r.calls.length, 0);
  }
});
test('duplicate identity fails visibly rather than linking an existing member', async () => {
  const r = await request({ db: { rpc: async () => ({ error: { code: '23505' } }) } });
  assert.equal(r.status, 409);
  assert.match(r.payload.error, /already exists/);
});

test('GET returns only tenant-owned booking, roles and literal organisation search results', async () => {
  const tables = {
    booking: [{ id: tenantId, tenant_id: tenantId, event_id: tenantId, is_guest_booking: true, attendee_first_name: 'Original', guest_organisation_name: 'Typed only' }],
    event: [{ id: tenantId, tenant_id: tenantId, title: 'Fixture' }],
    role: [{ id: 'role', tenant_id: tenantId, name: 'Member' }, { id: 'other-role', tenant_id: 'other', name: 'Other' }],
    organization: [{ id: 'org', tenant_id: tenantId, name: 'A*B' }, { id: 'other-org', tenant_id: 'other', name: 'A*B' }, { id: 'wildcard', tenant_id: tenantId, name: 'AXYZB' }],
  };
  const db = { from(table) {
    let rows = tables[table] || [], single = false;
    const q = {
      select() { return q; }, order() { return q; },
      overlaps() { return q; },
      eq(k, v) { rows = rows.filter(r => r[k] === v); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      filter(k, op, pattern) { assert.equal(op, 'imatch'); rows = rows.filter(r => new RegExp(pattern, 'i').test(r[k])); return q; },
      range(start, end) { return Promise.resolve({ data: rows.slice(start, end + 1) }); },
      maybeSingle() { single = true; return q; },
      then(resolve, reject) { return Promise.resolve({ data: single ? rows[0] || null : rows }).then(resolve, reject); },
    };
    return q;
  } };
  const req = { method: 'GET', query: { bookingId: tenantId, isComplex: 'false', organisationSearch: 'A*B' } };
  const r = await request({ db }, req);
  assert.equal(r.status, 200);
  assert.equal(r.payload.registration.supplied_organization_name, 'Typed only');
  assert.deepEqual(r.payload.roles.map(r => r.id), ['role']);
  assert.deepEqual(r.payload.organisations.map(r => r.id), ['org']);
  const outside = await request({ db, getContext: async () => ({ tenantId: 'other', isAuthenticated: true }) }, req);
  assert.equal(outside.status, 404);
});

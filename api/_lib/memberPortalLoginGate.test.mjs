import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateMemberPortalLoginGate,
  MEMBER_PORTAL_GATE_BLOCKED_MESSAGE,
  RECURRING_PAYMENT_RESTRICTED_MESSAGE,
  RECURRING_PAYMENT_SUSPENDED_MESSAGE,
} from './organisationLoginGate.js';

const TENANT_ID = 'tenant-1';

function supabaseMock({
  tenant = { id: TENANT_ID, settings: {} },
  organizations = [],
  paymentPlans = [],
  failures = {},
} = {}) {
  const calls = [];
  const writes = [];

  return {
    calls,
    writes,
    client: {
      from(table) {
        calls.push(table);
        if (failures[table] === 'throw') {
          throw new Error(`${table} unavailable`);
        }

        const filters = [];
        let orderedBy = null;
        const query = {
          select() { return query; },
          eq(column, value) {
            filters.push((row) => row?.[column] === value);
            return query;
          },
          in(column, values) {
            filters.push((row) => values.includes(row?.[column]));
            return query;
          },
          order(column, options) {
            orderedBy = { column, ascending: options?.ascending !== false };
            return query;
          },
          limit() { return query; },
          async maybeSingle() {
            const failure = failures[table];
            if (failure) {
              return {
                data: null,
                error: typeof failure === 'object'
                  ? failure
                  : { message: `${table} unavailable` },
              };
            }

            let rows = table === 'tenant'
              ? (tenant ? [tenant] : [])
              : (table === 'membership_payment_plans' ? paymentPlans : organizations);
            rows = rows.filter((row) => filters.every((filter) => filter(row)));
            if (orderedBy) {
              const direction = orderedBy.ascending ? 1 : -1;
              rows = [...rows].sort((a, b) => (
                String(a?.[orderedBy.column] ?? '')
                  .localeCompare(String(b?.[orderedBy.column] ?? '')) * direction
              ));
            }
            return { data: rows[0] || null, error: null };
          },
          insert(payload) { writes.push({ table, payload }); return query; },
          update(payload) { writes.push({ table, payload }); return query; },
          upsert(payload) { writes.push({ table, payload }); return query; },
        };
        return query;
      },
    },
  };
}

const member = (organizationId, overrides = {}) => ({
  id: 'member-1',
  tenant_id: TENANT_ID,
  organization_id: organizationId,
  ...overrides,
});

async function evaluate(mock, options = {}) {
  return evaluateMemberPortalLoginGate({
    supabase: mock.client,
    tenantId: TENANT_ID,
    userType: 'member',
    member: member('org-primary'),
    ...options,
  });
}

test('member portal login defaults to enabled for missing tenant, settings, or value', async () => {
  for (const tenant of [null, { id: TENANT_ID }, { id: TENANT_ID, settings: {} }]) {
    const result = await evaluate(supabaseMock({ tenant }));
    assert.deepEqual(result, { blocked: false, message: null, reason: 'ENABLED' });
  }
});

test('overdue recurring policy restricts or suspends the matching member without rewriting member flags', async () => {
  const restricted = supabaseMock({
    paymentPlans: [{
      id: 'plan-restrict',
      tenant_id: TENANT_ID,
      member_id: 'member-1',
      organization_id: null,
      status: 'payment_overdue',
      arrears_policy_applied: 'restrict',
      arrears_policy_applied_at: '2026-09-01T00:00:00Z',
    }],
  });
  assert.deepEqual(await evaluate(restricted), {
    blocked: true,
    message: RECURRING_PAYMENT_RESTRICTED_MESSAGE,
    reason: 'RECURRING_PAYMENT_RESTRICTED',
  });
  assert.deepEqual(restricted.writes, []);

  const suspended = supabaseMock({
    paymentPlans: [{
      id: 'plan-suspend',
      tenant_id: TENANT_ID,
      member_id: null,
      organization_id: 'org-primary',
      status: 'payment_overdue',
      arrears_policy_applied: 'suspend',
      arrears_policy_applied_at: '2026-09-01T00:00:00Z',
    }],
  });
  assert.deepEqual(await evaluate(suspended), {
    blocked: true,
    message: RECURRING_PAYMENT_SUSPENDED_MESSAGE,
    reason: 'RECURRING_PAYMENT_SUSPENDED',
  });
});

test('recurring arrears lookup is tenant-scoped and recovery restores access', async () => {
  const plan = {
    id: 'plan-foreign',
    tenant_id: 'tenant-2',
    member_id: 'member-1',
    status: 'payment_overdue',
    arrears_policy_applied: 'suspend',
  };
  const mock = supabaseMock({ paymentPlans: [plan] });
  assert.equal((await evaluate(mock)).blocked, false);

  plan.tenant_id = TENANT_ID;
  plan.status = 'active';
  plan.arrears_policy_applied = null;
  assert.equal((await evaluate(mock)).blocked, false);
});

test('disabled portal blocks non-primary and missing organizations with fixed message', async () => {
  const mock = supabaseMock({
    tenant: { id: TENANT_ID, settings: { member_portal_login_enabled: false } },
    organizations: [
      { id: 'org-primary', tenant_id: TENANT_ID, is_primary: true, created_at: '2025-02-01' },
      { id: 'org-other', tenant_id: TENANT_ID, is_primary: false, created_at: '2025-01-01' },
    ],
  });

  const nonPrimary = await evaluate(mock, { member: member('org-other') });
  assert.equal(nonPrimary.blocked, true);
  assert.equal(nonPrimary.message, MEMBER_PORTAL_GATE_BLOCKED_MESSAGE);
  assert.equal(nonPrimary.reason, 'MEMBER_ORGANIZATION_NOT_PRIMARY');

  const missing = await evaluate(mock, { member: member(null) });
  assert.equal(missing.blocked, true);
  assert.equal(missing.message, 'Access to the member portal is currently unavailable');
  assert.equal(missing.reason, 'MEMBER_ORGANIZATION_MISSING');
});

test('disabled portal blocks stale and cross-tenant organization membership', async () => {
  const settings = { member_portal_login_enabled: false };
  const mock = supabaseMock({
    tenant: { id: TENANT_ID, settings },
    organizations: [
      { id: 'org-primary', tenant_id: TENANT_ID, is_primary: true, created_at: '2025-01-01' },
      { id: 'org-foreign', tenant_id: 'tenant-2', is_primary: true, created_at: '2024-01-01' },
    ],
  });

  assert.equal((await evaluate(mock, { member: member('org-deleted') })).blocked, true);
  assert.equal((await evaluate(mock, { member: member('org-foreign') })).blocked, true);
  const wrongTenantMember = await evaluate(mock, {
    member: member('org-primary', { tenant_id: 'tenant-2' }),
  });
  assert.deepEqual(wrongTenantMember, {
    blocked: true,
    message: MEMBER_PORTAL_GATE_BLOCKED_MESSAGE,
    reason: 'MEMBER_TENANT_MISMATCH',
  });
});

test('explicit tenant-scoped primary organization member is allowed', async () => {
  const result = await evaluate(supabaseMock({
    tenant: {
      id: TENANT_ID,
      settings: { member_portal_login_enabled: false },
    },
    organizations: [
      { id: 'foreign-primary', tenant_id: 'tenant-2', is_primary: true, created_at: '2024-01-01' },
      { id: 'org-primary', tenant_id: TENANT_ID, is_primary: true, created_at: '2025-01-01' },
    ],
  }));

  assert.deepEqual(result, {
    blocked: false,
    message: null,
    reason: 'PRIMARY_ORGANIZATION_MEMBER',
  });
});

test('legacy tenants use their earliest-created organization when no primary is marked', async () => {
  const mock = supabaseMock({
    tenant: {
      id: TENANT_ID,
      settings: { member_portal_login_enabled: false },
    },
    organizations: [
      { id: 'org-later', tenant_id: TENANT_ID, created_at: '2023-05-01' },
      { id: 'org-earliest', tenant_id: TENANT_ID, created_at: '2020-01-01' },
    ],
  });

  const result = await evaluate(mock, { member: member('org-earliest') });
  assert.equal(result.blocked, false);
  assert.equal(result.reason, 'PRIMARY_ORGANIZATION_MEMBER');
});

test('tenant users and admins are immune without database access', async () => {
  const mock = supabaseMock({
    tenant: {
      id: TENANT_ID,
      settings: { member_portal_login_enabled: false },
    },
    failures: { tenant: 'throw' },
  });

  for (const userType of ['tenant_user', 'admin']) {
    const result = await evaluateMemberPortalLoginGate({
      supabase: mock.client,
      tenantId: TENANT_ID,
      userType,
      member: member(null),
    });
    assert.deepEqual(result, {
      blocked: false,
      message: null,
      reason: 'USER_TYPE_EXEMPT',
    });
  }
  assert.deepEqual(mock.calls, []);
});

test('changing the setting re-enables login immediately and performs no writes', async () => {
  const tenant = {
    id: TENANT_ID,
    settings: { member_portal_login_enabled: false },
  };
  const mock = supabaseMock({
    tenant,
    organizations: [
      { id: 'org-primary', tenant_id: TENANT_ID, is_primary: true, created_at: '2025-01-01' },
    ],
  });

  assert.equal((await evaluate(mock, { member: member('org-other') })).blocked, true);
  tenant.settings.member_portal_login_enabled = true;
  assert.deepEqual(await evaluate(mock, { member: member('org-other') }), {
    blocked: false,
    message: null,
    reason: 'ENABLED',
  });
  assert.deepEqual(mock.writes, []);
});

test('transient tenant and organization lookup errors or throws fail open', async () => {
  const tenantFailure = await evaluate(supabaseMock({
    failures: { tenant: { message: 'timeout', code: '57014' } },
  }));
  assert.equal(tenantFailure.blocked, false);
  assert.equal(tenantFailure.reason, 'TENANT_LOOKUP_FAILED');

  const disabledTenant = {
    id: TENANT_ID,
    settings: { member_portal_login_enabled: false },
  };
  const orgFailure = await evaluate(supabaseMock({
    tenant: disabledTenant,
    failures: { organization: { message: 'connection reset', code: '08006' } },
  }));
  assert.equal(orgFailure.blocked, false);
  assert.equal(orgFailure.reason, 'PRIMARY_LOOKUP_FAILED');

  const thrown = await evaluate(supabaseMock({
    tenant: disabledTenant,
    failures: { organization: 'throw' },
  }));
  assert.deepEqual(thrown, {
    blocked: false,
    message: null,
    reason: 'LOOKUP_FAILED',
  });
});
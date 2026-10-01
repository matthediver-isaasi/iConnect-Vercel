import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberMembershipHandler } from './member-membership.js';
import { createMemberHistoryHandler } from './member-history.js';
import { attachExpiryRenewalPolicyDisplay } from '../_lib/membershipRenewalPolicyDisplay.js';

const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
const memberId = '295ba406-921e-42a9-817b-563fcd56378b';
const historyId = 'c74442a4-ede3-5df7-a1a1-11fea2c26afe';
const configId = 'b59692c9-07b0-469d-9f6e-9d314a270926';
const owner = { id: memberId, tenant_id: tenantId, organization_id: null };
const history = {
  id: historyId, tenant_id: tenantId, member_id: memberId,
  membership_source: 'personal', membership_year: '2025/2026',
  status: 'active', payment_status: 'paid', payment_method: 'upfront',
  billing_period: 'annual', currency: 'GBP', tier_label: 'Full member',
  term_end_date: '2026-09-25', term_start_date: null, config_id: null,
  membership_renewal_date: null, term_key: null, term_duration_months: null,
  commitment_snapshot: null, billing_agreement_id: null,
  annual_cost: null, final_cost: null, total_with_vat: null,
  notes: JSON.stringify({ source: 'bnms_non_dd_current_backfill' }),
};
const assignment = {
  id: 'approved-assignment', tenant_id: tenantId, history_id: historyId,
  member_id: memberId, config_id: configId, expiry_date: '2026-09-25',
  config_name: '2026-2027 Full member', approval_source: 'operator',
  approval_evidence: 'private operator evidence',
  policy_snapshot: {
    renewal_open_days: 90, renewal_grace_days: 90,
    renewal_disable_login: true, renewal_change_role: false,
    renewal_fallback_role_id: null,
  },
};
const expectedDisplay = {
  policySource: 'operator_assigned_expiry_only', configId,
  configName: '2026-2027 Full member', paidThroughDate: '2026-09-25',
  graceEndDate: '2026-12-24', renewalGraceDays: 90,
};

function database({ assignmentRow = assignment, assignmentError = null } = {}) {
  const calls = [];
  const tables = {
    member: [owner],
    member_membership_history: [history],
    membership_expiry_policy_assignment: assignmentRow ? [assignmentRow] : [],
    membership_tier_config: [{ id: configId, tenant_id: tenantId,
      structure_scope_type: 'member', billing_period: 'annual', annual_cost: 999 }],
  };
  return {
    calls,
    from(table) {
      const call = { table, filters: {} };
      calls.push(call);
      const result = (single = false) => {
        const rows = (tables[table] || []).filter(row => Object.entries(call.filters)
          .every(([key, value]) => row[key] === value)).map(row => structuredClone(row));
        return { data: single ? rows[0] || null : rows,
          error: table === 'membership_expiry_policy_assignment' ? assignmentError : null };
      };
      const chain = {
        select(columns) { call.columns = columns; return chain; },
        eq(key, value) { call.filters[key] = value; return chain; },
        in() { return chain; },
        order() { return chain; },
        async range() { return result(); },
        async maybeSingle() { return result(true); },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return chain;
    },
  };
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return payload; },
  };
}

function handler(db, options = {}) {
  return createMemberMembershipHandler({
    db,
    getTenantContext: async () => ({ tenantId }),
    getSessionMember: async () => owner,
    hasAdminAccess: async () => false,
    getConfigForMember: async () => null,
    getAllActiveConfigs: async () => [],
    enrichMembershipHistoryPrices: async () => {},
    simulateMembershipForMember: async () => { throw new Error('Must not simulate a purchase'); },
    getNow: () => new Date('2026-10-01T12:00:00Z'),
    ...options,
  });
}

test('authorized member API projects assigned renewal policy without restamping paid history or pricing', async () => {
  const db = database();
  const res = response();
  await handler(db)({ method: 'GET', query: { memberId } }, res);
  assert.equal(res.statusCode, 200);
  const row = res.payload.history[0];
  assert.deepEqual(row.expiry_renewal_policy, expectedDisplay);
  for (const key of ['membership_year', 'config_id', 'term_start_date', 'term_end_date',
    'annual_cost', 'final_cost', 'total_with_vat', 'membership_renewal_date']) {
    assert.equal(row[key], history[key], `historical ${key} is preserved`);
  }
  assert.equal(res.payload.config, null);
  assert.equal(res.payload.nextYearPreview, null);
  assert.deepEqual(res.payload.commitments, []);
  assert.deepEqual(res.payload.legacyCurrentMembership.expiry_renewal_policy, expectedDisplay);
  assert.equal(res.payload.legacyCurrentMembership.grace.policySource, expectedDisplay.policySource);
  assert.equal(res.payload.legacyCurrentMembership.paidAmount, null);
  assert.equal(res.payload.legacyCurrentMembership.startDate, null);
  assert.ok(!JSON.stringify(res.payload).includes(assignment.approval_evidence));
  const policyRead = db.calls.find(call => call.table === 'membership_expiry_policy_assignment');
  assert.deepEqual(policyRead.filters, { tenant_id: tenantId, history_id: historyId });
});

test('portal history API shares the safe projection and does not expose private legacy notes', async () => {
  const db = database();
  const res = response();
  const read = createMemberHistoryHandler({
    db, getTenantContext: async () => ({ tenantId, isAuthenticated: true }),
    getSessionMember: async () => owner, hasAdminAccess: async () => true,
    enrichMembershipHistoryPrices: async () => {},
  });
  await read({ method: 'GET', query: { memberId: 'ignored-other-member' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload[0].expiry_renewal_policy, expectedDisplay);
  assert.equal(res.payload[0].notes, undefined);
  assert.equal(res.payload[0].config_id, null);
  assert.equal(res.payload[0].final_cost, null);
  assert.equal(res.payload[0].membership_year, '2025/2026');
  assert.ok(!JSON.stringify(res.payload).includes(assignment.approval_evidence));
});

for (const code of ['42P01', 'PGRST205']) {
  test(`missing assignment schema ${code} means no assignment, not a provider error fallback`, async () => {
    const row = structuredClone(history);
    const db = database({ assignmentError: { code, message: 'Missing schema' } });
    await attachExpiryRenewalPolicyDisplay(db, { tenantId, memberId, history: [row] });
    assert.equal(row.expiry_renewal_policy, undefined);
    assert.equal(row.expiry_renewal_policy_error, undefined);
  });
}

for (const failure of [
  { assignmentError: { code: '08006', message: 'private database connection detail' } },
  { assignmentError: { code: '42703', message: 'Invalid schema column' } },
  { assignmentRow: { ...assignment, member_id: 'different-owner' } },
  { assignmentRow: { ...assignment, expiry_date: '2026-09-26' } },
]) {
  test(`unreadable or invalid assignment is explicitly unavailable and cannot infer grace: ${JSON.stringify(failure)}`, async () => {
    const res = response();
    await handler(database(failure))({ method: 'GET', query: { memberId } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.history[0].expiry_renewal_policy, undefined);
    assert.match(res.payload.history[0].expiry_renewal_policy_error, /Renewal policy unavailable/);
    assert.equal(res.payload.legacyCurrentMembership, null);
    assert.ok(!JSON.stringify(res.payload).includes('private database connection detail'));
  });
}

test('notes cannot assign renewal policy and organisation or foreign-owned rows are never projected', async () => {
  const row = { ...structuredClone(history), notes: JSON.stringify({
    source: 'bnms_non_dd_current_backfill',
    renewal_policy: assignment.policy_snapshot, config_id: configId,
  }) };
  const otherRows = [
    { ...history, membership_source: 'organisation' },
    { ...history, tenant_id: 'other-tenant' },
    { ...history, member_id: 'other-member' },
  ];
  const db = database({ assignmentRow: null });
  await attachExpiryRenewalPolicyDisplay(db, { tenantId, memberId, history: [row, ...otherRows] });
  assert.equal(row.expiry_renewal_policy, undefined);
  assert.equal(row.expiry_renewal_policy_error, undefined);
  for (const other of otherRows) assert.equal(other.expiry_renewal_policy, undefined);
  assert.equal(db.calls.filter(call => call.table === 'membership_expiry_policy_assignment').length, 1);
});

test('membership IDOR and tenant mismatch reject before any policy or member query', async () => {
  for (const [requestId, sessionOwner, expectedStatus] of [
    ['other-member', owner, 403],
    [memberId, { ...owner, tenant_id: 'other-tenant' }, 409],
  ]) {
    const db = database();
    const res = response();
    await handler(db, { getSessionMember: async () => sessionOwner })(
      { method: 'GET', query: { memberId: requestId } }, res,
    );
    assert.equal(res.statusCode, expectedStatus);
    assert.deepEqual(db.calls, []);
  }
});

test('membership policy projection is read-only', async () => {
  const db = database();
  const res = response();
  await handler(db)({ method: 'POST', query: { memberId }, body: assignment }, res);
  assert.equal(res.statusCode, 405);
  assert.deepEqual(db.calls, []);
});
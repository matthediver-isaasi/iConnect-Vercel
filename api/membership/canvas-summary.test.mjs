import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCanvasSummary, canvasDate, createCanvasSummaryHandler, selectCanvasCommitment } from './canvas-summary.js';

const today = '2026-09-18';
const member = { id: 'member-a', tenant_id: 'tenant-a', organization_id: 'org-a', role_id: 'role-a' };
const term = (patch = {}) => ({
  id: 'term-a', tenant_id: 'tenant-a', member_id: 'member-a',
  membership_source: 'personal', term_key: '2026-term',
  term_start_date: '2026-01-01', membership_renewal_date: '2027-01-01',
  tier_label: 'Professional', status: 'active', payment_status: 'partial',
  payment_method: 'stripe', ...patch,
});
const orgTerm = (patch = {}) => term({
  id: 'org-term', member_id: undefined, organization_id: 'org-a',
  membership_source: 'organisation', tier_label: 'Organisation', ...patch,
});
const summary = (personal, organisation = [], options = {}) => buildCanvasSummary({
  selected: selectCanvasCommitment(personal, organisation, today), today, ...options,
});

const legacyTenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const legacyTerm = (patch = {}) => ({
  id: 'legacy', tenant_id: legacyTenant, member_id: member.id, membership_source: 'personal',
  membership_year: '2025/2026', tier_label: 'Full Membership UK',
  status: 'active', payment_status: 'paid', payment_method: 'upfront',
  billing_period: 'annual', currency: 'GBP', term_end_date: '2026-10-16',
  notes: JSON.stringify({ source: 'bnms_non_dd_current_backfill', private: 'must-not-leak' }),
  ...patch,
});

test('reviewed upfront evidence is current and paid without invented commencement or renewal', () => {
  const value = summary([legacyTerm()]);
  assert.equal(value.membership.state, 'active');
  assert.equal(value.membership.expiryDate, '2026-10-16');
  assert.equal(value.membership.memberSince, null);
  assert.equal(value.membership.renewalDate, null);
  assert.equal(value.payment.state, 'paid');
  assert.equal(value.payment.method, 'upfront');
  assert.equal(value.payment.nextPayment, null);
  assert.equal(value.payment.amount, null);
  assert.equal(value.payment.confirmedPayment, null);
  assert.equal(summary([legacyTerm()], [], { paused: true }).membership.state, 'paused');
  assert.equal(summary([legacyTerm()], [], { paused: true }).payment.state, 'paused');
  assert.doesNotMatch(JSON.stringify(value), /must-not-leak|notes|snapshot/);
});

test('legacy recognition stays narrow and never revives stopped, expired or unrelated records', () => {
  for (const patch of [
    { notes: null }, { notes: '{invalid' }, { tenant_id: 'other' },
    { membership_source: 'organisation' }, { term_end_date: '2026-09-17' },
    { term_end_date: '2026-02-30' }, { status: 'cancelled' }, { status: 'paused' },
    { status: 'expired' }, { payment_status: 'unpaid' }, { billing_period: 'monthly' },
    { billing_agreement_id: 'agreement' }, { config_id: 'config' },
    { final_cost: 10, total_with_vat: null },
  ]) {
    const value = summary([legacyTerm(patch)]);
    assert.notEqual(value.membership.state, 'active', JSON.stringify(patch));
    assert.notEqual(value.payment.state, 'paid', JSON.stringify(patch));
    assert.equal(value.membership.expiryDate, undefined);
  }
});

test('API selects server-only legacy provenance but returns only display evidence', async () => {
  const owner = { ...member, tenant_id: legacyTenant };
  const h = harness({
    session: owner, context: { tenantId: legacyTenant },
    rows: { member: [owner], member_membership_history: [legacyTerm()] },
  });
  const response = await h.request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.membership.state, 'active');
  assert.equal(response.payload.membership.expiryDate, '2026-10-16');
  assert.equal(response.payload.payment.state, 'paid');
  assert.equal(response.payload.payment.method, 'upfront');
  assert.doesNotMatch(JSON.stringify(response.payload), /must-not-leak|notes|snapshot|legacy/);
  const otherOwner = await harness({
    session: owner, context: { tenantId: legacyTenant },
    rows: { member: [owner], member_membership_history: [legacyTerm({ member_id: 'other' })] },
  }).request();
  assert.equal(otherOwner.payload.membership.state, 'none');
});

test('existing migrated mandate is active while upcoming term remains unpaid and pending', () => {
  const history = term({ status: 'pending_payment_setup', payment_status: 'unpaid',
    term_start_date: '2026-10-01', payment_method: 'direct_debit', billing_period: 'monthly_direct_debit' });
  const plan = { provider: 'gocardless', status: 'mandate_pending', migratedMandateStatus: 'active',
    membership_billing_agreements: { metadata: { dd: {
      billing_request_mode: 'migration_existing_mandate', activation_rule: 'first_payment',
    } } } };
  const value = summary([history], [], { plan });
  assert.equal(value.membership.state, 'pending');
  assert.equal(value.membership.memberSince, null);
  assert.equal(value.payment.state, 'first_payment_pending');
  assert.equal(value.payment.nextPayment, null, 'a cutover is not a provider-scheduled charge');
  assert.equal(value.payment.mandateStatus, 'active');
  assert.equal(value.payment.collectionStatus, 'unscheduled');
  assert.equal(history.payment_status, 'unpaid');
  assert.equal(summary([history], [], { plan: { ...plan, collection_stopped_at: today } }).payment.state, 'paused');
  assert.equal(summary([history], [], { plan: { ...plan, migratedMandateStatus: 'cancelled' } }).payment.state, 'pending');
});

function dbFixture({ rows = {}, errors = {}, unfiltered = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [], offset: 0, end: Infinity };
      calls.push(call);
      const result = () => {
        let data = rows[table] || [];
        if (!unfiltered) data = data.filter(row => call.filters.every(([key, value, operator]) =>
          operator === 'in' ? value.includes(row[key]) : row[key] === value));
        data = data.slice(call.offset, call.end + 1);
        // Real PostgREST returns only selected columns. Do not let fixture-only
        // fields conceal an incomplete production query projection.
        if (call.columns) data = data.map(row => Object.fromEntries(call.columns.split(',')
          .map(column => column.trim()).map(column => [column, row[column]])));
        return { data, error: errors[table] || null };
      };
      const chain = {
        select(columns) { call.columns = columns; return chain; },
        eq(key, value) { call.filters.push([key, value]); return chain; },
        in(key, values) { call.filters.push([key, values, 'in']); return chain; },
        is(key, value) { call.filters.push([key, value]); return chain; },
        order() { return chain; },
        range(offset, end) { call.offset = offset; call.end = end; return chain; },
        limit(size) { call.end = size - 1; return chain; },
        maybeSingle() { const value = result(); return Promise.resolve({ ...value, data: value.data[0] || null }); },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return chain;
    },
  };
}

function harness({ session = member, context = { tenantId: 'tenant-a' }, admin = false,
  permission = true, rows = {}, errors, unfiltered } = {}) {
  const db = dbFixture({ rows: { member: [member], ...rows }, errors, unfiltered });
  const gates = [];
  const handler = createCanvasSummaryHandler({
    db, now: () => new Date(`${today}T12:00:00Z`),
    getSessionMember: async () => session,
    getTenantContext: async () => context,
    hasAdminAccess: async (value) => { gates.push(['admin', value]); return admin; },
    hasFeatureAccess: async (...args) => { gates.push(['feature', ...args]); return permission; },
  });
  async function request(patch = {}) {
    const res = {
      statusCode: 200, headers: {}, payload: null,
      setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return payload; },
    };
    await handler({ method: 'GET', query: {}, ...patch }, res);
    return res;
  }
  return { db, gates, request };
}

test('current personal term wins over current organisation and future personal terms', () => {
  const result = summary([
    term({ id: 'future', term_start_date: '2027-01-01', membership_renewal_date: '2028-01-01', tier_label: 'Future' }),
    term(),
  ], [orgTerm()]);
  assert.equal(result.membership.membershipType, 'Professional');
  assert.equal(result.membership.state, 'active');
  assert.equal(result.payment.method, 'card');
});

test('current organisation wins over past or future personal; billing remains unavailable', () => {
  const result = summary([
    term({ term_start_date: '2027-01-01', membership_renewal_date: '2028-01-01' }),
    term({ term_start_date: '2020-01-01', membership_renewal_date: '2021-01-01' }),
  ], [orgTerm(), orgTerm({ id: 'older-org', term_start_date: '2024-01-01', membership_renewal_date: '2025-01-01' })]);
  assert.deepEqual(result, {
    membership: {
      state: 'active', memberSince: null, membershipType: 'Organisation',
      renewalDate: '2027-01-01', paymentHistoryFrom: null,
    },
    payment: {
      state: 'unavailable', method: 'unavailable', nextPayment: null,
      amount: null, currency: null, collectionStatus: 'unavailable',
      plannedPayment: null, confirmedPayment: null, nextCollection: null, mandateStatus: null,
    },
  });
  assert.equal(summary([term({ status: 'expired' })], [orgTerm()]).membership.membershipType, 'Organisation');
});

test('member since is unavailable without a real persisted original-commencement source', () => {
  const result = summary([
    term(),
    term({ term_start_date: '2023-01-01', membership_renewal_date: null }),
    term({ term_start_date: '2022-02-30', membership_renewal_date: '2023-01-01' }),
    term({ term_start_date: '2001-01-01', membership_renewal_date: '2000-01-01' }),
  ], [orgTerm({ term_start_date: '2000-01-01' })]);
  assert.equal(result.membership.memberSince, null);
  assert.equal(summary([term(), { id: 'retained', term_start_date: '2005-01-01' }]).membership.memberSince, null);
});

test('date validation rejects rollover dates, arbitrary strings and non-strings', () => {
  for (const value of ['2026-02-30', '2026-13-01', '2026-01-01Tbroken', 'yesterday', '', 123, null]) assert.equal(canvasDate(value), null);
  assert.equal(canvasDate('2024-02-29'), '2024-02-29');
});

test('future-only is pending without inventing a commencement; past-only is expired', () => {
  const future = summary([term({ term_start_date: '2027-01-01', membership_renewal_date: '2028-01-01' })]);
  assert.equal(future.membership.state, 'pending');
  assert.equal(future.membership.memberSince, null);
  assert.equal(summary([term({ membership_renewal_date: today })]).membership.state, 'expired');
});

test('explicit end date is inclusive, missing or inverted dates never become active', () => {
  assert.equal(summary([term({ membership_renewal_date: null, term_end_date: today })]).membership.state, 'active');
  assert.equal(summary([term({ term_start_date: null })]).membership.state, 'unavailable');
  assert.equal(summary([term({ membership_renewal_date: '2025-01-01' })]).membership.state, 'unavailable');
});

test('legacy dated terms without rolling key, renewal or snapshot retain current/past lifecycle', () => {
  const legacy = term({ term_key: null, membership_renewal_date: null, term_end_date: '2026-12-31' });
  assert.equal(summary([legacy]).membership.state, 'active');
  assert.equal(summary([legacy]).membership.memberSince, null);
  assert.equal(summary([{ ...legacy, term_end_date: '2026-08-31' }]).membership.state, 'expired');
  assert.equal(summary([{ ...legacy, term_start_date: '2027-01-01', term_end_date: '2027-12-31' }]).membership.state, 'pending');
  assert.equal(summary([{ ...legacy, term_end_date: '2025-12-31' }]).membership.state, 'unavailable');
});

test('partial payment does not imply pending membership; pause does not expose login state', () => {
  assert.equal(summary([term({ status: 'partial' })]).membership.state, 'active');
  assert.equal(summary([term()], [], { paused: true }).membership.state, 'paused');
  assert.equal(summary([term({ status: 'pending_payment_setup' })]).membership.state, 'pending');
  assert.equal(summary([term({ login_enabled: false })]).membership.state, 'active');
});

test('explicit failed/manual-pending history is not active; billing grace never grants or revokes membership', () => {
  assert.equal(summary([term({ status: 'failed' })]).membership.state, 'failed');
  assert.equal(summary([term({ status: 'activation_failed' })]).membership.state, 'failed');
  assert.equal(summary([term({ status: 'pending_activation' })]).membership.state, 'pending');
  for (const status of [null, 'unknown', 'payment_grace_period', 'payment_overdue']) {
    assert.equal(summary([term({ status })]).membership.state, 'unavailable', String(status));
  }
  for (const status of ['payment_grace_period', 'payment_overdue']) {
    const result = summary([term()], [], { plan: { status } });
    assert.equal(result.membership.state, 'active', 'only the retained membership access status controls membership');
    assert.equal(result.payment.state, 'failed');
  }
});

test('only confirmed upfront settlement reports paid, never recurring setup success', () => {
  for (const payment_status of ['paid', 'partial', 'unpaid']) {
    for (const payment_method of ['stripe', 'invoice', 'bank_transfer']) {
      const result = summary([term({ status: 'paid', payment_status, payment_method, billing_period: 'annual' })]);
      assert.equal(result.membership.state, 'active');
      assert.equal(result.payment.state, payment_status === 'paid' ? 'paid' : 'unavailable');
      assert.equal(result.payment.nextPayment, null);
    }
  }
});

test('paid annual card term without a recurring plan retains settlement and separate renewal date', async () => {
  const h = harness({ rows: { member_membership_history: [term({
    term_key: 'rolling:2026-09-18', membership_year: 'rolling:2026-09-18',
    term_start_date: today, term_end_date: '2027-09-17', membership_renewal_date: '2027-09-18',
    tier_label: 'Flat Rate', billing_period: 'annual', billing_agreement_id: null,
    payment_method: 'stripe', payment_status: 'paid',
    commitment_snapshot: { payment_frequency: 'upfront', billing_period: 'annual', payment_method: 'stripe' },
  })] } });
  const response = await h.request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.membership.state, 'active');
  assert.equal(response.payload.membership.renewalDate, '2027-09-18');
  assert.deepEqual(response.payload.payment, {
    state: 'paid', method: 'card', nextPayment: null, amount: null, currency: null,
    collectionStatus: 'unavailable', plannedPayment: null, confirmedPayment: null,
    nextCollection: null, mandateStatus: null,
  });
  assert.ok(!h.db.calls.some(call => call.table === 'membership_payment_plans'));
});

test('unconfirmed, monthly, expired or unlinked recurring records cannot become paid-upfront success', () => {
  const paid = { billing_period: 'annual', payment_status: 'paid' };
  for (const patch of [
    { payment_status: null }, { payment_status: 'partial' }, { payment_status: 'unpaid' },
    { billing_period: 'monthly' }, { payment_method: 'direct_debit' },
    { billing_agreement_id: 'unmatched-agreement' },
    { commitment_snapshot: { payment_frequency: 'monthly' } },
    { commitment_snapshot: { billing_period: 'monthly', payment_frequency: 'upfront' } },
    { membership_renewal_date: '2026-01-02' },
  ]) {
    assert.equal(summary([term({ ...paid, ...patch })]).payment.state, 'unavailable', JSON.stringify(patch));
  }
  const withPlan = summary([term(paid)], [], {
    plan: { status: 'active', provider: 'stripe', interval_unit: 'monthly', next_charge_date: '2026-10-01' },
  });
  assert.equal(withPlan.payment.state, 'active');
  assert.equal(withPlan.payment.nextPayment, '2026-10-01');
  assert.deepEqual(withPlan.payment.plannedPayment, {
    date: '2026-10-01', amount: null, currency: null,
  });
  assert.deepEqual(withPlan.payment.nextCollection, {
    date: '2026-10-01', amount: null, currency: null, status: 'planned',
  });
  assert.equal(withPlan.payment.collectionStatus, 'planned');
});

test('monthly billing without a matching plan never reports setup success', () => {
  for (const payment_method of ['card_monthly', 'monthly_direct_debit', 'stripe_monthly_card']) {
    const result = summary([term({ payment_method, payment_status: 'paid' })]);
    assert.equal(result.payment.state, 'unavailable');
    assert.notEqual(result.payment.method, 'unavailable', 'the retained method is still truthful');
  }
});

test('empty and ambiguous histories are distinct; no creation date or membership-year guessing', () => {
  assert.equal(summary([]).membership.state, 'none');
  const result = summary([{ id: 'legacy', membership_year: '2020/2021', created_at: '2020-01-01' }]);
  assert.equal(result.membership.state, 'unavailable');
  assert.equal(result.membership.memberSince, null);
});

test('persisted snapshot supplies type and date without consulting live configuration', () => {
  const result = summary([term({
    tier_label: null, term_start_date: null, membership_renewal_date: null,
    commitment_snapshot: {
      term_start_date: '2026-02-01', membership_renewal_date: '2027-02-01',
      config: { name: 'Retained tier' },
    },
  })]);
  assert.equal(result.membership.membershipType, 'Retained tier');
  assert.equal(result.membership.memberSince, null);
});

for (const [stored, expected] of [
  ['stripe', 'card'], ['card_monthly', 'monthly_card'], ['stripe_monthly_card', 'monthly_card'],
  ['direct_debit', 'direct_debit'], ['monthly_direct_debit', 'monthly_direct_debit'],
  ['invoice', 'invoice'], ['bank_transfer', 'bank_transfer'], ['unknown', 'unavailable'],
]) {
  test(`normalizes payment method ${stored}`, () => {
    const result = summary([term({ payment_method: stored })]);
    assert.equal(result.payment.method, expected);
    assert.equal(result.payment.nextPayment, null, 'renewal must never substitute for collection');
  });
}

test('effective collection uses persisted catch-up, suppresses unresolved arrears and stopped collection', () => {
  const base = { status: 'active', provider: 'gocardless', interval_unit: 'monthly', next_charge_date: '2026-10-01' };
  const get = (patch) => summary([term({ payment_method: 'direct_debit' })], [], { plan: { ...base, ...patch } }).payment;
  assert.equal(get({}).method, 'monthly_direct_debit');
  assert.equal(get({}).nextPayment, '2026-10-01');
  assert.equal(get({ membership_monthly_arrears_period: [{ settled_at: null }] }).nextPayment, null);
  assert.equal(get({ metadata: { catch_up_intent: { status: 'created', provider_charge_date: '2026-09-25' } } }).nextPayment, '2026-09-25');
  assert.equal(get({ collection_stopped_at: '2026-09-01' }).nextPayment, null);
  assert.equal(get({ collection_stopped_at: '2026-09-01' }).state, 'paused');
  assert.equal(get({ next_charge_date: '2026-09-01' }).nextPayment, null);
  assert.equal(get({ status: 'payment_overdue' }).state, 'failed');
  assert.equal(get({ status: 'mandate_pending' }).state, 'pending');
  assert.equal(get({ status: 'payment_plan_cancelled' }).nextPayment, null);
  assert.equal(get({ status: 'expired' }).nextPayment, null);
  assert.equal(get({ membership_billing_agreements: { status: 'payment_plan_cancelled' } }).nextPayment, null);
  assert.equal(get({ membership_billing_agreements: { status: 'expired' } }).state, 'expired');
});

test('authenticated response is minimal, tenant scoped and private no-store', async () => {
  const h = harness({ rows: { member_membership_history: [term()] } });
  const res = await h.request();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.payload), ['membership', 'payment']);
  assert.deepEqual(Object.keys(res.payload.membership), [
    'state', 'memberSince', 'membershipType', 'renewalDate', 'paymentHistoryFrom',
  ]);
  assert.deepEqual(Object.keys(res.payload.payment), [
    'state', 'method', 'nextPayment', 'amount', 'currency', 'collectionStatus',
    'plannedPayment', 'confirmedPayment', 'nextCollection', 'mandateStatus',
  ]);
  assert.match(res.headers['Cache-Control'], /private, no-store/);
  assert.match(res.headers.Vary, /Cookie/);
  assert.ok(h.db.calls.every(call => call.filters.some(([key, value]) => key === 'tenant_id' && value === 'tenant-a')));
  assert.deepEqual(h.gates[1].slice(1), ['role-a', 'commerce.history', undefined]);
});

test('history query projections respect each owner schema and avoid unsupported organisation billing', async () => {
  const h = harness({ rows: { member_membership_history: [term()], organisation_membership_history: [orgTerm()] } });
  assert.equal((await h.request()).statusCode, 200);
  const personal = h.db.calls.find(call => call.table === 'member_membership_history').columns.split(',').map(s => s.trim());
  const org = h.db.calls.find(call => call.table === 'organisation_membership_history').columns.split(',').map(s => s.trim());
  assert.ok(personal.includes('member_id'));
  assert.ok(personal.includes('billing_agreement_id'));
  assert.ok(!personal.includes('organization_id'));
  assert.ok(org.includes('organization_id'));
  for (const column of ['member_id', 'billing_agreement_id', 'payment_status']) assert.ok(!org.includes(column));
  assert.ok(personal.includes('payment_status'), 'personal upfront settlement must be read, not inferred');

  // Verify migration evidence without connecting to a database. Both ledgers
  // actually have settlement columns; personal billing now needs settlement,
  // while unsupported organisation billing deliberately does not read it.
  const migration = name => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
  const personalBilling = migration('20260726_gocardless_phase2_dd_config.sql');
  const orgBilling = migration('20260726_gocardless_phase3_org_dd.sql');
  const settlement = migration('20260525_membership_history_payment_status.sql');
  assert.match(personalBilling, /ALTER TABLE member_membership_history\s+ADD COLUMN IF NOT EXISTS billing_agreement_id/);
  assert.match(orgBilling, /ALTER TABLE organisation_membership_history\s+ADD COLUMN IF NOT EXISTS billing_agreement_id/);
  for (const table of ['member_membership_history', 'organisation_membership_history']) {
    assert.match(settlement, new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN IF NOT EXISTS payment_status`));
  }
  const existingHistory = readFileSync(new URL('./member-history.js', import.meta.url), 'utf8');
  const personalSelect = existingHistory.match(/const PERSONAL_COLUMNS = \[([\s\S]*?)\]\.join/)[1];
  const orgSelect = existingHistory.match(/const ORGANISATION_COLUMNS = \[([\s\S]*?)\]\.join/)[1];
  // Server-only attestation fields are intentionally absent from the public
  // history projection. The API regression above exercises their selection.
  for (const column of personal.filter(column => !['billing_agreement_id', 'payment_status',
    'notes', 'currency', 'config_id', 'term_duration_months', 'final_cost', 'total_with_vat'].includes(column))) {
    assert.ok(personalSelect.includes(`'${column}'`), `personal ${column} must match the existing history schema`);
  }
  for (const column of org) assert.ok(orgSelect.includes(`'${column}'`), `organisation ${column} must match the existing history schema`);
});

for (const [name, options, status] of [
  ['guest', { session: null }, 401],
  ['tenant admin without member', { session: null, admin: true }, 401],
  ['tenant mismatch', { context: { tenantId: 'tenant-b' } }, 409],
  ['flagged tenant mismatch', { context: { tenantId: 'tenant-a', tenantMismatch: true } }, 409],
  ['missing tenant', { context: {} }, 403],
  ['history gate denied', { permission: false }, 403],
  ['missing role', { session: { ...member, role_id: null } }, 403],
]) {
  test(`${name} is rejected before any membership reads`, async () => {
    const h = harness(options);
    const res = await h.request();
    assert.equal(res.statusCode, status);
    assert.equal(h.db.calls.length, 0);
    assert.match(res.headers['Cache-Control'], /no-store/);
  });
}

test('member feature exclusions are passed through unchanged; member admin retains existing bypass', async () => {
  const exclusions = ['commerce.history'];
  const h = harness({ session: { ...member, member_excluded_features: exclusions }, permission: false });
  assert.equal((await h.request()).statusCode, 403);
  assert.equal(h.gates[1][3], exclusions);
  assert.equal((await harness({ admin: true, permission: false }).request()).statusCode, 200);
});

test('all identity overrides and methods are rejected, even self/admin selectors', async () => {
  for (const query of [{ memberId: member.id }, { member_id: 'other' }, { organizationId: 'org-a' }, { tenantId: 'tenant-a' }, { admin: '1' }]) {
    const h = harness({ admin: true });
    assert.equal((await h.request({ query })).statusCode, 400);
    assert.equal(h.db.calls.length, 0);
  }
  assert.equal((await harness().request({ body: { memberId: member.id } })).statusCode, 400);
  assert.equal((await harness().request({ method: 'POST' })).statusCode, 405);
});

test('organisation fallback uses current persisted assignment, not stale session organisation', async () => {
  const h = harness({ rows: { member: [{ ...member, organization_id: 'org-new' }], organisation_membership_history: [
    orgTerm(), orgTerm({ organization_id: 'org-new', tier_label: 'New org' }),
  ] } });
  const result = await h.request();
  assert.equal(result.payload.membership.membershipType, 'New org');
  assert.equal(h.db.calls.find(call => call.table === 'organisation_membership_history').filters[1][1], 'org-new');
});

test('two viewers sharing a tenant receive only their own commitments; unlinked members cannot read organisation history', async () => {
  const other = { ...member, id: 'member-b', organization_id: null };
  const rows = {
    member: [member, other],
    member_membership_history: [term(), term({ id: 'term-b', member_id: 'member-b', tier_label: 'Private B' })],
  };
  const first = await harness({ rows }).request();
  const second = harness({ rows, session: other });
  assert.equal(first.payload.membership.membershipType, 'Professional');
  assert.equal((await second.request()).payload.membership.membershipType, 'Private B');
  assert.ok(!second.db.calls.some(call => call.table === 'organisation_membership_history'));
});

test('retained history is paged beyond default row caps without inventing commencement', async () => {
  const rows = Array.from({ length: 501 }, (_, index) => term({
    id: `row-${index}`,
    term_start_date: index === 500 ? '2000-01-01' : '2026-01-01',
  }));
  const h = harness({ rows: { member_membership_history: rows } });
  assert.equal((await h.request()).payload.membership.memberSince, null);
  assert.equal(h.db.calls.filter(call => call.table === 'member_membership_history').length, 2);
});

const billingRows = (patch = {}) => ({
  member_membership_history: [term({ billing_agreement_id: 'agreement-a' })],
  membership_billing_agreements: [{ id: 'agreement-a', tenant_id: 'tenant-a', member_id: 'member-a', term_key: '2026-term', provider: 'stripe' }],
  membership_payment_plans: [{ id: 'plan-a', tenant_id: 'tenant-a', member_id: 'member-a', billing_agreement_id: 'agreement-a', status: 'active', interval_unit: 'monthly', provider: 'stripe', next_charge_date: '2026-10-01' }],
  ...patch,
});

test('self API reads scoped migration mandate evidence and preserves upcoming term boundaries', async () => {
  const rows = billingRows();
  Object.assign(rows.member_membership_history[0], {
    payment_method: 'direct_debit', status: 'pending_payment_setup', payment_status: 'unpaid',
    term_start_date: '2026-10-01',
  });
  Object.assign(rows.membership_billing_agreements[0], {
    provider: 'gocardless', metadata: { dd: {
      billing_request_mode: 'migration_existing_mandate', activation_rule: 'first_payment',
    } },
  });
  Object.assign(rows.membership_payment_plans[0], {
    provider: 'gocardless', environment: 'live', gocardless_mandate_id: 'mandate-a',
    status: 'mandate_pending', next_charge_date: null,
  });
  rows.gocardless_mandates = [{
    tenant_id: 'tenant-a', environment: 'live', gocardless_mandate_id: 'mandate-a', status: 'active',
  }];
  const result = await harness({ rows }).request();
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.payment.state, 'first_payment_pending');
  assert.equal(result.payload.membership.state, 'pending');
  assert.equal(result.payload.membership.memberSince, null);
  assert.equal(result.payload.payment.nextPayment, null);
  assert.ok(!JSON.stringify(result.payload).includes('mandate-a'));
  rows.gocardless_mandates[0].status = 'cancelled';
  assert.equal((await harness({ rows }).request()).payload.payment.state, 'pending');
  assert.equal((await harness({ rows, errors: { gocardless_mandates: new Error('unavailable') } }).request()).statusCode, 500);
});

test('matching agreement/plan supplies collection and never returns billing identifiers', async () => {
  const rows = billingRows();
  Object.assign(rows.membership_payment_plans[0], { amount_minor: 0, currency: 'gbp' });
  const res = await harness({ rows }).request();
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.payment.nextPayment, '2026-10-01');
  assert.equal(res.payload.payment.method, 'monthly_card');
  assert.equal(res.payload.payment.amount, 0, 'zero is a known amount, not missing');
  assert.equal(res.payload.payment.currency, 'GBP');
  assert.equal(res.payload.payment.collectionStatus, 'planned');
  assert.equal(res.payload.payment.nextCollection.status, 'planned');
  assert.ok(!JSON.stringify(res.payload).includes('agreement-a'));
});

test('pilot immutable payments provide historical context without becoming commencement or schedule', async () => {
  const rows = billingRows();
  Object.assign(rows.member_membership_history[0], {
    id: 'history-pilot', payment_method: 'direct_debit', status: 'pending_payment_setup',
    term_start_date: '2026-10-01',
  });
  Object.assign(rows.membership_billing_agreements[0], {
    provider: 'gocardless',
    metadata: { dd: { billing_request_mode: 'migration_existing_mandate', activation_rule: 'first_payment' } },
  });
  Object.assign(rows.membership_payment_plans[0], {
    provider: 'gocardless', status: 'first_payment_pending', next_charge_date: null,
    environment: 'live', gocardless_mandate_id: 'mandate-a',
  });
  rows.gocardless_mandates = [{
    tenant_id: 'tenant-a', environment: 'live', gocardless_mandate_id: 'mandate-a', status: 'active',
  }];
  rows.bnms_dd_pilot_adoption = [{
    tenant_id: 'tenant-a', member_id: 'member-a', agreement_id: 'agreement-a',
    plan_id: 'plan-a', history_id: 'history-pilot', historical_import_id: 'import-a',
  }];
  rows.bnms_dd_historical_payment = [
    {
      tenant_id: 'tenant-a', member_id: 'member-a', import_id: 'import-a',
      period: '2026-01-01', charge_date: '2026-01-06', amount_minor: 1304,
      currency: 'GBP', provider_status: 'paid_out', historical_only: true,
    },
    {
      tenant_id: 'tenant-a', member_id: 'member-a', import_id: 'import-a',
      period: '2026-09-01', charge_date: '2026-09-04', amount_minor: 1304,
      currency: 'GBP', provider_status: 'paid_out', historical_only: true,
    },
  ];
  const response = await harness({ rows }).request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.membership.memberSince, null);
  assert.equal(response.payload.membership.paymentHistoryFrom, '2026-01-01');
  assert.equal(response.payload.payment.nextPayment, null);
  assert.equal(response.payload.payment.collectionStatus, 'unscheduled');
  assert.deepEqual(response.payload.payment.confirmedPayment, {
    date: '2026-09-04', amount: 13.04, currency: 'GBP', historical: true,
  });
  assert.equal(response.payload.payment.amount, null, 'historical payment is never the next amount');
  assert.equal(response.payload.payment.mandateStatus, 'active');
});

test('past payment and confirmed future provider schedule remain distinct', async () => {
  const rows = billingRows();
  Object.assign(rows.member_membership_history[0], { payment_method: 'direct_debit' });
  Object.assign(rows.membership_billing_agreements[0], { provider: 'gocardless' });
  Object.assign(rows.membership_payment_plans[0], {
    provider: 'gocardless', next_charge_date: null, amount_minor: null, currency: 'GBP',
  });
  rows.gocardless_payments = [{
    tenant_id: 'tenant-a', plan_id: 'plan-a', amount_minor: 975, currency: 'gbp',
    charge_date: '2026-09-10', confirmed_at: '2026-09-12T08:30:00Z', status: 'paid_out',
  }, {
    tenant_id: 'tenant-a', plan_id: 'plan-a', amount_minor: 1100, currency: 'GBP',
    charge_date: '2026-10-10', confirmed_at: '2026-09-15T08:30:00Z', status: 'confirmed',
  }];
  const response = await harness({ rows }).request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.payment.nextPayment, '2026-10-10');
  assert.equal(response.payload.payment.plannedPayment, null);
  assert.equal(response.payload.payment.collectionStatus, 'confirmed');
  assert.deepEqual(response.payload.payment.nextCollection, {
    date: '2026-10-10', amount: 11, currency: 'GBP', status: 'confirmed',
  });
  assert.deepEqual(response.payload.payment.confirmedPayment, {
    date: '2026-09-12', amount: 9.75, currency: 'GBP', historical: false,
  });
  assert.equal(response.payload.payment.amount, 11);
  for (const status of ['pending_submission', 'submitted', 'paid_out']) {
    rows.gocardless_payments[1].status = status;
    const variant = await harness({ rows }).request();
    assert.equal(variant.payload.payment.collectionStatus, 'confirmed', status);
    assert.equal(variant.payload.payment.nextCollection.status, 'confirmed', status);
  }
});

test('unscheduled fixed plan retains authoritative amount without borrowing a prior payment', async () => {
  const rows = billingRows();
  Object.assign(rows.member_membership_history[0], { payment_method: 'direct_debit' });
  Object.assign(rows.membership_billing_agreements[0], { provider: 'gocardless' });
  Object.assign(rows.membership_payment_plans[0], {
    provider: 'gocardless', next_charge_date: null, amount_minor: 1300, currency: 'GBP',
  });
  const response = await harness({ rows }).request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.payment.collectionStatus, 'unscheduled');
  assert.equal(response.payload.payment.nextPayment, null);
  assert.equal(response.payload.payment.amount, 13);
  assert.equal(response.payload.payment.confirmedPayment, null);
});

test('all unresolved arrears are paged into catch-up arithmetic and unknown amounts fail closed', async () => {
  const arrears = Array.from({ length: 501 }, (_, index) => ({
    id: `arrears-${String(index).padStart(3, '0')}`, tenant_id: 'tenant-a',
    plan_id: 'plan-a', amount_minor: 1, settled_at: null,
  }));
  const rows = billingRows({
    membership_monthly_arrears_period: arrears,
  });
  Object.assign(rows.membership_billing_agreements[0], {
    metadata: { card: { monthly_post_grace_collection_policy: 'continue_catch_up' } },
  });
  Object.assign(rows.membership_payment_plans[0], { amount_minor: 100, currency: 'GBP' });
  const complete = harness({ rows });
  const response = await complete.request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.payment.amount, 6.01);
  assert.equal(complete.db.calls.filter(call => call.table === 'membership_monthly_arrears_period').length, 2);

  arrears[500].amount_minor = null;
  const unknown = await harness({ rows }).request();
  assert.equal(unknown.statusCode, 200);
  assert.equal(unknown.payload.payment.amount, null);
  assert.equal(unknown.payload.payment.plannedPayment, null);
});

test('renewed agreement and unrelated member plans cannot supply next collection', async () => {
  const rows = billingRows();
  rows.membership_billing_agreements[0].term_key = '2027-term';
  const h = harness({ rows });
  assert.equal((await h.request()).payload.payment.nextPayment, null);
  assert.ok(!h.db.calls.some(call => call.table === 'membership_payment_plans'));
  const unrelated = billingRows();
  unrelated.membership_payment_plans[0].billing_agreement_id = 'other';
  assert.equal((await harness({ rows: unrelated }).request()).payload.payment.nextPayment, null);
});

test('agreement date can prove identity when term key absent; no identity means unavailable collection', async () => {
  const rows = billingRows();
  delete rows.membership_billing_agreements[0].term_key;
  assert.equal((await harness({ rows }).request()).payload.payment.nextPayment, null);
  rows.membership_billing_agreements[0].term_start_date = '2026-01-01';
  assert.equal((await harness({ rows }).request()).payload.payment.nextPayment, '2026-10-01');
  rows.membership_billing_agreements[0].term_key = '2026-term';
  rows.membership_billing_agreements[0].term_start_date = '2027-01-01';
  assert.equal((await harness({ rows }).request()).payload.payment.nextPayment, null);
});

test('tenant/owner corruption fails closed even if a database adapter ignores filters', async () => {
  for (const table of ['member', 'member_membership_history', 'membership_billing_agreements', 'membership_payment_plans']) {
    const rows = { member: [member], ...billingRows() };
    rows[table] = rows[table].map(row => ({ ...row, tenant_id: 'other-tenant' }));
    const res = await harness({ rows, unfiltered: true }).request();
    assert.equal(res.statusCode, 500, table);
    assert.deepEqual(res.payload, { error: 'Unable to load membership summary' });
  }
});

test('database failures are explicit errors, never a successful empty or partially leaked response', async () => {
  for (const table of ['member', 'member_membership_history', 'organisation_membership_history', 'membership_billing_agreements', 'membership_payment_plans', 'membership_monthly_arrears_period']) {
    const res = await harness({ rows: billingRows(), errors: { [table]: { message: 'private SQL detail' } } }).request();
    assert.equal(res.statusCode, 500, table);
    assert.equal(JSON.stringify(res.payload).includes('private SQL'), false);
    assert.match(res.headers['Cache-Control'], /no-store/);
  }
});
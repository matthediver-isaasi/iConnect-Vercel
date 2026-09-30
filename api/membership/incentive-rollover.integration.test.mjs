import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { membershipIncentiveSnapshot } from '../_lib/membershipIncentiveSnapshot.js';
import { createMembershipSimulator } from '../_lib/membershipSimulationCore.js';
import { runAnnualOwnerRow } from '../_lib/annualOwnerRenewalPipeline.js';

const failure = {
  success: false,
  code: 'new_member_incentive_review_required',
  error: 'New-member incentive requires review: original entitlement is unavailable.',
};
const forbidden = () => { throw new Error('Unexpected database/provider side effect'); };

// A read-only simulator boundary: the actual simulator must not turn a
// prospective tab estimate into evidence for a renewal/payment writer.
function simulatorFixture(history = [], overrides = [], configOverrides = {}) {
  const config = {
    id: 'joining', tenant_id: 'tenant', name: 'Annual', pricing_model: 'flat',
    start_mode: 'fixed_date', flat_cost: 1833.47, currency: 'GBP',
    billing_period: 'annual', membership_start_month: 8, membership_start_day: 1,
    prorata_enabled: true, free_period_amount: 30, free_period_unit: 'percent',
    rollover_enabled: true, created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...configOverrides,
  };
  const tables = {
    organization: [{ id: 'org', name: 'Organisation', tenant_id: 'tenant' }],
    membership_tier_config: [config],
    organisation_membership_invoicing: [],
    organisation_membership_history: history,
    organisation_membership_override: overrides,
    membership_tier_discount: [],
    preference_field: [{ id: 'join-field', tenant_id: 'tenant', entity_scope: 'organization', is_active: true, name: 'go_live' }],
    organization_preference_value: [{ field_id: 'join-field', organization_id: 'org', value: '2026-09-18' }],
  };
  const db = { from(table) {
    const filters = [];
    let single = false;
    const query = {
      select() { return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      or() { return query; },
      order() { return query; },
      limit() { return query; },
      maybeSingle() { single = true; return query; },
      then(resolve, reject) {
        const rows = (tables[table] || []).filter(row => filters.every(fn => fn(row)));
        return Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(resolve, reject);
      },
      insert: forbidden, update: forbidden, upsert: forbidden, delete: forbidden,
    };
    return query;
  } };
  return createMembershipSimulator(db, () => new Date('2026-09-24T00:00:00Z'));
}

test('workflow simulator price override bypasses pro-rata and preserves £1 net plus £0.20 VAT', async () => {
  const simulator = simulatorFixture([], [{
    tenant_id: 'tenant', organization_id: 'org', membership_year: '2026/2027',
    override_type: 'price', manual_price: 1,
  }], {
    flat_cost: 950, free_period_amount: 0, rollover_enabled: false,
    flat_vat_rate: JSON.stringify({ taxType: 'OUTPUT2', name: '20% VAT' }),
  });
  const result = await simulator.simulateMembershipForOrg('tenant', 'org', {
    source: 'workflow', targetYear: '2026/2027',
  });
  assert.equal(result.success, true, result.error);
  assert.equal(result.overrideType, 'price');
  assert.equal(result.annualCost, 1);
  assert.equal(result.finalCost, 1);
  assert.equal(result.vatAmount, .2);
  assert.equal(result.totalWithVat, 1.2);
  assert.equal(result.freeDiscount, 0);
  assert.equal(result.membershipYear.label, '2026/2027');
  assert.equal(membershipIncentiveSnapshot(result).commitment_snapshot, undefined);
});

test('actual financial simulator does not consume a tab estimate as purchased Year 1 evidence', async () => {
  const simulator = simulatorFixture();
  const tab = await simulator.simulateMembershipForOrg('tenant', 'org', {
    source: 'tab', targetYear: '2027/2028', asOfDate: '2027-08-01',
  });
  assert.equal(tab.success, true, tab.error);
  assert.equal(tab.previewOnly, true);
  assert.equal(tab.incentiveRollover.source, 'prospective_year1_projection');
  for (const source of ['manual', 'member-portal', 'cron', 'simulate']) {
    const quote = await simulator.simulateMembershipForOrg('tenant', 'org', {
      source, targetYear: '2027/2028', asOfDate: '2027-08-01',
    });
    assert.notEqual(quote.previewOnly, true, source);
    assert.notEqual(quote.incentiveRollover?.source, 'prospective_year1_projection', source);
  }
  const second = simulatorFixture([], [{
    tenant_id: 'tenant', organization_id: 'org', membership_year: '2026/2027',
    override_type: 'price', manual_price: 1,
  }]);
  const estimate = await second.simulateMembershipForOrg('tenant', 'org', {
    source: 'tab', targetYear: '2027/2028',
  });
  assert.equal(estimate.previewOnly, true);
  assert.equal(estimate.rolloverDiscount, 0);
  const payment = await second.simulateMembershipForOrg('tenant', 'org', {
    source: 'member-portal', targetYear: '2027/2028', asOfDate: '2027-08-01',
  });
  assert.notEqual(payment.previewOnly, true);
  assert.notEqual(payment.incentiveRollover?.source, 'prospective_year1_projection');
});

test('paid and unpaid Year 1 snapshots remain authoritative for tab and financial quotes', async () => {
  const config = {
    id: 'joining', tenant_id: 'tenant', pricing_model: 'flat', start_mode: 'fixed_date',
    flat_cost: 1833.47, currency: 'GBP', billing_period: 'annual',
    membership_start_month: 8, membership_start_day: 1,
    prorata_enabled: true, free_period_amount: 30, free_period_unit: 'percent', rollover_enabled: true,
  };
  for (const snapshotField of ['commitment_snapshot', 'incentive_snapshot']) {
  for (const status of ['paid', 'unpaid']) {
    const history = [{
      id: `y1-${status}`, tenant_id: 'tenant', organization_id: 'org',
      membership_year: '2026/2027', config_id: config.id, year_number: 1,
      status: 'active', payment_status: status, annual_cost: 1833.47,
      currency: 'GBP', free_period_discount: 477.71, free_period_days_applied: 0,
      [snapshotField]: { config }, created_at: '2026-09-18T00:00:00Z',
    }];
    const simulator = simulatorFixture(history);
    for (const source of ['tab', 'member-portal', 'manual']) {
      const result = await simulator.simulateMembershipForOrg('tenant', 'org', {
        source, targetYear: '2027/2028', asOfDate: '2027-08-01',
      });
      assert.equal(result.success, true, `${status}/${source}: ${result.error}`);
      assert.notEqual(result.previewOnly, true);
      assert.equal(result.incentiveRollover.source, snapshotField);
      assert.equal(result.rolloverDiscount, 72.33);
    }
  }
  }
});

// Evaluate the actual route with every imported boundary replaced. No live
// database, auth, email or accounting module is loaded by these route tests.
async function isolatedRoute(file, overrides = {}) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  const deps = { supabase: { from: forbidden }, getTenantContext: async () => ({ tenantId: 'tenant' }),
    hasAdminAccess: async () => true, simulateMembershipForOrg: async () => failure,
    simulateMembershipForMember: async () => failure, ...overrides };
  const body = source.replace(/import\s+\{([\s\S]*?)\}\s+from\s+['"][^'"]+['"];?/g, (_, names) => {
    for (const name of names.split(',').map(n => n.trim()).filter(Boolean)) deps[name] ??= forbidden;
    return '';
  }).replace('export default async function handler', 'async function handler');
  return new Function(...Object.keys(deps), `${body}; return handler;`)(...Object.values(deps));
}

for (const [file, body] of [
  ['./org-membership.js', { organizationId: 'org', membershipYear: '2027' }],
  ['./org-membership-invoicing.js', { organizationId: 'org', membershipYear: '2027' }],
  ['./org-membership-invoicing.js', { organizationId: 'org', membershipYear: '2027', advance: true }],
  ['./member-membership-invoicing.js', { memberId: 'member', membershipYear: '2027' }],
  ['./email-fees.js', { organizationId: 'org', membershipYear: '2027' }],
  ['./email-fees.js', { memberId: 'member', membershipYear: '2027' }],
]) {
  test(`${file} ${JSON.stringify(body)} blocks unproven incentive before side effects`, async () => {
    const handler = await isolatedRoute(file);
    const res = { status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method: 'POST', body, headers: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, failure.code);
    assert.equal(res.body.error, failure.error);
  });
}

test('tab mapping keeps Y1 and Y2 discounts distinct and preserves original evidence', async () => {
  const source = await readFile(new URL('./org-membership.js', import.meta.url), 'utf8');
  const start = source.indexOf('function mapSimResultToYearData(');
  const end = source.indexOf('\n}', start) + 2;
  const map = new Function(`${source.slice(start, end)}; return mapSimResultToYearData;`)();
  const evidence = { source: 'commitment_snapshot', originalEntitlement: 400, usedInYear1: 100, remainingEntitlement: 300, appliedDiscount: 300, unit: 'percent' };
  const mapped = map({ yearNumber: 2, freeDiscount: 0, rolloverDiscount: 300, incentiveRollover: evidence }, '2027-01-01');
  assert.equal(mapped.freeDiscount, 0);
  assert.equal(mapped.rolloverDiscount, 300);
  assert.deepEqual(mapped.incentiveRollover, evidence);
});

test('fee email breakdown passes the original evidence and explicit Y2 credit unchanged', async () => {
  const incentiveRollover = { source: 'commitment_snapshot', originalEntitlement: 400, usedInYear1: 100, remainingEntitlement: 300, appliedDiscount: 300, unit: 'percent' };
  let sent;
  const handler = await isolatedRoute('./email-fees.js', {
    supabase: { from() { return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null }), insert: async () => ({}) }; } },
    simulateMembershipForOrg: async () => ({ success: true, org: { name: 'Organisation' },
      membershipYear: { label: '2027' }, config: {}, yearNumber: 2, finalCost: 900,
      annualCost: 1200, vatAmount: 180, totalWithVat: 1080, freeDiscount: 0, rolloverDiscount: 300, incentiveRollover }),
    loadAddonLines: async () => [], computeAddonTotals: () => ({ subtotal: 0, vat: 0, total: 0 }),
    sendMembershipFeeTokenEmail: async options => { sent = options; return { success: true, sentTo: ['test@example.invalid'] }; },
  });
  const res = { status() { return this; }, json(value) { return value; } };
  await handler({ method: 'POST', body: { organizationId: 'org', recipientEmail: 'test@example.invalid' }, headers: {} }, res);
  assert.equal(sent.costBreakdown.freeDiscount, 0);
  assert.equal(sent.costBreakdown.rolloverDiscount, 300);
  assert.deepEqual(sent.costBreakdown.incentiveRollover, incentiveRollover);
  assert.equal(sent.costBreakdown.totalWithVat, 1080);
});

test('fee email rollover label does not claim the current schedule percentage', async () => {
  const source = await readFile(new URL('../_lib/membershipFeeTokenEmail.js', import.meta.url), 'utf8');
  const start = source.indexOf('function buildBreakdownRows(');
  const end = source.indexOf('\n}', start) + 2;
  const rowsFor = new Function(`${source.slice(start, end)}; return buildBreakdownRows;`)();
  const rows = rowsFor('£', { annualCost: 1200, freePeriodUnit: 'percent', freePeriodAmount: 90, freeDiscount: 0, rolloverDiscount: 300 }, 900, 'Membership');
  assert.equal(rows.filter(row => row.isDiscount).length, 1);
  assert.equal(rows.find(row => row.isDiscount).label, 'New Member Discount (rollover from Y1)');
});

test('joining schedule snapshot is immutable and renewals never overwrite original evidence', () => {
  const sim = { yearNumber: 1, annualCost: 1000, config: { id: 'joining', free_period_amount: 40, free_period_unit: 'percent', rollover_enabled: true } };
  const saved = membershipIncentiveSnapshot(sim);
  sim.config.free_period_amount = 90;
  assert.equal(saved.incentive_snapshot.config.free_period_amount, 40);
  assert.equal(saved.incentive_snapshot.amounts.annual_cost, 1000);
  assert.deepEqual(membershipIncentiveSnapshot({ ...sim, yearNumber: 2 }), {});
});

test('annual pipeline reports review code and never writes or invoices', async () => {
  const traces = [];
  const result = await runAnnualOwnerRow({
    db: { from: forbidden }, tenantId: 'tenant', scope: 'organisation',
    setting: { organization_id: 'org', invoicing_mode: 'automatic' }, now: new Date('2027-01-01'),
    effects: { perform: forbidden }, trace: row => traces.push(row),
    simulator: { simulateMembershipForOrg: async () => failure },
  });
  assert.equal(result.code, failure.code);
  assert.equal(result.skipped, true);
  assert.equal(traces[0].reason, failure.error);
  assert.equal(traces[0].code, failure.code);
});

test('annual insertion persists original config plus separate discounts', async () => {
  const db = { from() { return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null }) }; } };
  const sim = { success: true, org: { name: 'Organisation' }, goLiveDate: '2026-01-01',
    membershipYear: { label: '2026', start: '2026-01-01' }, config: { id: 'joining', start_mode: 'fixed_date', free_period_amount: 40 },
    yearNumber: 1, annualCost: 1000, finalCost: 600, totalWithVat: 600, freeDiscount: 400, rolloverDiscount: 0, currency: 'GBP' };
  let operation;
  await runAnnualOwnerRow({ db, tenantId: 'tenant', scope: 'organisation', setting: { organization_id: 'org', invoicing_mode: 'automatic' },
    now: new Date('2026-01-01'), simulator: { simulateMembershipForOrg: async () => sim },
    effects: { perform: async op => { operation = op; } } });
  assert.equal(operation.type, 'owner.annual_history_insert');
  assert.deepEqual(operation.payload.values.incentive_snapshot.config, sim.config);
  assert.equal(operation.payload.values.free_period_discount, 400);
  assert.equal(operation.payload.values.rollover_discount, 0);
});
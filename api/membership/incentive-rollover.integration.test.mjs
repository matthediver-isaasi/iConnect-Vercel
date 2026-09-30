import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { membershipIncentiveSnapshot } from '../_lib/membershipIncentiveSnapshot.js';
import { runAnnualOwnerRow } from '../_lib/annualOwnerRenewalPipeline.js';

const failure = {
  success: false,
  code: 'new_member_incentive_review_required',
  error: 'New-member incentive requires review: original entitlement is unavailable.',
};
const forbidden = () => { throw new Error('Unexpected database/provider side effect'); };

// Evaluate the actual route with every imported boundary replaced. No live
// database, auth, email or accounting module is loaded by these route tests.
async function isolatedRoute(file, overrides = {}) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  const deps = { supabase: { from: forbidden }, getTenantContext: async () => ({ tenantId: 'tenant' }),
    simulateMembershipForOrg: async () => failure, simulateMembershipForMember: async () => failure, ...overrides };
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
  assert.equal(saved.commitment_snapshot.config.free_period_amount, 40);
  assert.equal(saved.commitment_snapshot.amounts.annual_cost, 1000);
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
  assert.deepEqual(operation.payload.values.commitment_snapshot.config, sim.config);
  assert.equal(operation.payload.values.free_period_discount, 400);
  assert.equal(operation.payload.values.rollover_discount, 0);
});
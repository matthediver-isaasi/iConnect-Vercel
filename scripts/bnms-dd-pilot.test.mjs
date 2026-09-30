import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMBER_ID, TENANT_ID, MANDATE_ID, CUSTOMER_ID, MONTHS, assertPilot,
  makeManifest, parseArgs, providerReader, readAllProviderPages, validateGrid,
} from './bnms-dd-pilot.mjs';

function fixture() {
  return {
    pilot: { memberId: MEMBER_ID, email: 'pilot@example.test' },
    member: { id: MEMBER_ID, tenant_id: TENANT_ID, email: 'pilot@example.test' },
    memberClass: 'Associate',
    mappings: [{ member_class: 'Associate', structure_id: 'structure' }],
    structures: [{ id: 'structure', tenant_id: TENANT_ID, is_active: true, structure_scope_type: 'member', structure_match_value: 'Associate' }],
    mandate: { id: MANDATE_ID, status: 'active', links: { customer: CUSTOMER_ID } },
    customer: { id: CUSTOMER_ID },
    subscriptions: [], payments: [], existing: { agreements: [], history: [], plans: [] },
  };
}

test('pilot boundary is immutable, including apply/resume and unknown CLI options', () => {
  assert.doesNotThrow(() => assertPilot(MEMBER_ID));
  assert.throws(() => assertPilot('other'), /immutable/);
  for (const flag of ['--apply', '--resume', '--member', '--tenant']) {
    assert.throws(() => parseArgs([flag, MEMBER_ID]), /deliberately unavailable/);
  }
  assert.throws(() => parseArgs(['--workbook', 'w', '--class-map', 'm', '--out', './private.json']), /outside the repository/);
});

test('real first-member evidence cannot fabricate a subscription, history or invoice', () => {
  const plan = makeManifest(fixture());
  assert.equal(plan.readyToApply, false);
  assert.equal(plan.writesPerformed, 0);
  assert.equal(plan.blockers.includes('NO_ACTIVE_SUBSCRIPTION'), false);
  assert.equal(plan.blockers.includes('SUBSCRIPTION_AMBIGUOUS'), false);
  assert.ok(plan.blockers.includes('PROMOTION_NOT_IMPLEMENTED'));
  assert.ok(plan.blockers.includes('XERO_HANDOVER_NOT_VERIFIED'));
  assert.ok(plan.blockers.includes('PRICE_AND_TERM_APPROVAL_REQUIRED'));
  assert.deepEqual(plan.existingSchedule, {
    source: 'xero', collectionMechanism: 'one_off_gocardless_payments',
    evidence: 'user_confirmed', subscriptionExpected: false, handoverVerified: false,
  });
  assert.equal(plan.subscription, null);
  assert.equal(plan.history.length, 9);
  assert.deepEqual(plan.history.map((m) => m.period), MONTHS);
  assert.ok(plan.history.every((m) => m.payments.length === 0 && m.status === 'needs_review'));
  assert.deepEqual(makeManifest(fixture()), plan);
});

test('cross-tenant, deleted members, wrong provider identity and duplicate class map block', () => {
  const f = fixture();
  f.member.tenant_id = 'foreign';
  f.mandate.links.customer = 'other';
  f.mappings.push({ ...f.mappings[0] });
  const result = makeManifest(f);
  for (const issue of ['MEMBER_IDENTITY_CONFLICT', 'MANDATE_CUSTOMER_CONFLICT', 'CLASS_MAPPING_UNRESOLVED']) assert.ok(result.blockers.includes(issue));
  assert.throws(() => makeManifest({ ...f, pilot: { ...f.pilot, memberId: 'other' } }), /immutable/);
});

test('existing records, conflicting subscriptions and schedule are review-only', () => {
  const f = fixture();
  f.existing.history.push({ id: 'existing' });
  f.subscriptions.push({ id: 'SB1', status: 'active', interval_unit: 'monthly', interval: 1, day_of_month: 15, currency: 'GBP', links: { mandate: MANDATE_ID } });
  let result = makeManifest(f);
  assert.ok(result.blockers.includes('EXISTING_MEMBERSHIP_REQUIRES_RECONCILIATION'));
  assert.ok(result.blockers.includes('COLLECTION_SCHEDULE_CONFLICT'));
  f.subscriptions.push({ ...f.subscriptions[0], id: 'SB2' });
  result = makeManifest(f);
  assert.ok(result.blockers.includes('SUBSCRIPTION_AMBIGUOUS'));
});

test('period is nominal first of month, actual dates and nonsettled status preserved', () => {
  const f = fixture();
  f.payments = [
    { id: 'PM1', charge_date: '2026-01-05', amount: 500, currency: 'GBP', status: 'failed', links: { mandate: MANDATE_ID } },
    { id: 'PM2', charge_date: '2026-10-01', amount: 500, currency: 'GBP', status: 'pending_submission', links: { mandate: MANDATE_ID } },
  ];
  const result = makeManifest(f);
  assert.equal(result.history[0].period, '2026-01-01');
  assert.equal(result.history[0].payments[0].charge_date, '2026-01-05');
  assert.ok(result.history[0].issues.includes('PAYMENT_NOT_SETTLED'));
  assert.equal(result.history[0].issues.includes('PAYMENT_SUBSCRIPTION_CONFLICT'), false);
  assert.equal(result.octoberPaymentEvidence[0].id, 'PM2');
  assert.equal(result.history.flatMap((m) => m.payments).length, 1);
});

test('Xero one-off payment without a subscription is not a subscription conflict', () => {
  const f = fixture();
  f.payments = [{ id: 'PM1', charge_date: '2026-01-08', amount: 591, currency: 'GBP',
    status: 'paid_out', links: { mandate: MANDATE_ID, subscription: null } }];
  let result = makeManifest(f);
  assert.equal(result.history[0].issues.includes('PAYMENT_SUBSCRIPTION_CONFLICT'), false);
  assert.ok(result.blockers.includes('XERO_HANDOVER_NOT_VERIFIED'));
  assert.equal(result.readyToApply, false);
  f.subscriptions = [{ id: 'SB1', status: 'active', interval_unit: 'monthly', interval: 1,
    day_of_month: 1, currency: 'GBP', links: { mandate: MANDATE_ID } }];
  result = makeManifest(f);
  assert.ok(result.history[0].issues.includes('PAYMENT_SUBSCRIPTION_CONFLICT'));
  assert.ok(result.blockers.includes('EXISTING_SUBSCRIPTIONS_REQUIRE_RECONCILIATION'));
  f.subscriptions[0].links.mandate = 'other';
  assert.ok(makeManifest(f).blockers.includes('SUBSCRIPTION_MANDATE_CONFLICT'));
  f.subscriptions[0].status = 'cancelled';
  assert.ok(makeManifest(f).blockers.includes('SUBSCRIPTION_AMBIGUOUS'));
});

test('provider pagination exhausts all pages and rejects incomplete, duplicate or cycling reads', async () => {
  const calls = [];
  const rows = await readAllProviderPages(async (resource, query) => {
    calls.push(query);
    return { payments: [{ id: query.after ? 'PM2' : 'PM1' }], meta: { cursors: { after: query.after ? null : 'next' } } };
  }, 'payments', { mandate: MANDATE_ID });
  assert.equal(rows.length, 2);
  assert.equal(calls[1].after, 'next');
  assert.equal(calls[1].mandate, MANDATE_ID);
  for (const body of [
    { payments: [] },
    { payments: [], meta: { cursors: { after: 'next' } } },
    { payments: [{ id: 'PM1' }], meta: { cursors: { after: 'same' } } },
  ]) {
    await assert.rejects(readAllProviderPages(async () => body, 'payments', {}));
  }
  let count = 0;
  await assert.rejects(readAllProviderPages(async () => {
    if (count++) throw new Error('provider unavailable');
    return { payments: [{ id: 'PM1' }], meta: { cursors: { after: 'next' } } };
  }, 'payments', {}), /provider unavailable/);
});

test('provider reader cannot redirect, mutate, access arbitrary resources or use fallback credentials', async () => {
  const credentials = { source: 'tenant', tenantId: TENANT_ID, environment: 'live', accessToken: 'test-fixture' };
  const calls = [];
  const get = providerReader(credentials, async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({}) };
  });
  await get('subscriptions', { mandate: MANDATE_ID });
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(get('payments/PM1/actions/retry'), /allowlist/);
  assert.equal(calls.length, 1);
  assert.throws(() => providerReader({ ...credentials, source: 'env' }), /tenant credentials/);
  assert.throws(() => providerReader({ ...credentials, accessToken: 'sandbox_test' }), /tenant credentials/);
});

test('spreadsheet pilot conflicts and shape drift rejected', () => {
  const header = ['match_outcome', 'customer_email', 'normalized_email', 'iConnect Email address', 'iConnect UUID', 'gocardless_customer_id', 'gocardless_mandate_id', 'mandate_status', 'matched_member_id', 'error_message'];
  const row = ['', '', '', 'pilot@example.test', MEMBER_ID, CUSTOMER_ID, MANDATE_ID, '', '', ''];
  const grid = [header, ...Array.from({ length: 47 }, (_, i) => ['', '', '', '', `member${i}`, `customer${i}`, `mandate${i}`, '', '', ''])];
  grid[3] = row;
  assert.equal(validateGrid(grid).memberId, MEMBER_ID);
  assert.throws(() => validateGrid(grid.slice(1)), /shape drift/);
  grid[2] = [...row];
  assert.throws(() => validateGrid(grid), /Conflicting/);
});
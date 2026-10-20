import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shapePersistedCommitment, shapePersistedCommitments, shapeLegacyCurrentMembership, createMemberMembershipHandler } from './member-membership.js';
import { selectCanvasCommitment } from './canvas-summary.js';
import { runScheduledActivation } from '../_lib/directDebitOwnerPipeline.js';
import { isCurrentMembershipProtection } from '../_lib/annualMembershipExpiryEnforcement.js';
import { reconcileRow } from '../_lib/membershipPaymentReconciliation.js';
import { resolveReminderPaymentQuote } from '../_lib/reminderPaymentQuote.js';
import { enrichMembershipHistoryPrices } from '../_lib/membershipHistoryPrice.js';
import { createMembershipSimulator } from '../_lib/membershipSimulationCore.js';
import { getMembershipPricingPresentation } from '../../client/src/components/membership/membershipPricingPresentation.js';
import { classifyAnnualRenewal, resolveEntityAnnualRenewalEligibility } from '../_lib/annualRenewalPolicy.js';
import { findUnresolvedUnverifiedHistory } from '../../shared/unverifiedMembershipHistory.js';

const now = new Date('2026-06-01T00:00:00Z');
const history = {
  id: 'legacy', tenant_id: 'tenant', member_id: 'member',
  membership_source: 'personal', membership_year: '2025/2026',
  status: 'active', payment_status: 'unverified', payment_method: 'upfront',
  final_cost: null, total_with_vat: null,
};
const deny = () => { throw new Error('Unexpected financial read/effect'); };
const laterPaid = {
  ...history, id: 'new-purchase', membership_year: '2026/2027',
  payment_status: 'paid', term_key: 'rolling:2026-01-01',
  term_start_date: '2026-01-01', term_end_date: '2026-12-31',
  membership_renewal_date: '2027-01-01',
  term_anchor_date: '2026-01-01', term_duration_months: 12,
  commitment_snapshot: { start_mode: 'immediate', payment_frequency: 'upfront' },
};

test('only unresolved relevant history holds pricing; an older unknown does not poison a later purchase', () => {
  assert.equal(findUnresolvedUnverifiedHistory([history, laterPaid]), null);
  assert.equal(findUnresolvedUnverifiedHistory([laterPaid, history]), null);
  const currentUnknown = { ...history, membership_year: '2027/2028' };
  assert.equal(findUnresolvedUnverifiedHistory([laterPaid, currentUnknown]), currentUnknown);
  assert.equal(findUnresolvedUnverifiedHistory([history, { ...laterPaid, payment_status: 'unpaid' }]), history);
  assert.equal(findUnresolvedUnverifiedHistory([history, { ...laterPaid, status: 'cancelled' }]), history);
  assert.equal(findUnresolvedUnverifiedHistory([history, { ...laterPaid, member_id: 'other' }]), history);
  assert.equal(findUnresolvedUnverifiedHistory([history, { ...laterPaid, tenant_id: 'other' }]), history);
  const ongoing = { ...laterPaid, payment_status: 'partial', billing_agreement_id: 'verified-agreement' };
  assert.equal(findUnresolvedUnverifiedHistory([history, ongoing]), null);
  assert.equal(findUnresolvedUnverifiedHistory([history, laterPaid], { previousTerm: history }), history);
  assert.equal(findUnresolvedUnverifiedHistory([history, laterPaid], { targetYear: history.membership_year }), history);
});

test('rolling simulation selects the independently paid purchase, never the older unknown as predecessor', async () => {
  const db = { from() {
    const query = { select() { return query; }, eq() { return query; },
      then(resolve, reject) { return Promise.resolve({ data: [history, laterPaid] }).then(resolve, reject); } };
    return query;
  } };
  const simulator = createMembershipSimulator(db, () => now);
  const result = await simulator.resolveRollingSimulationContext(db, {
    tenantId: 'tenant', memberId: 'member', config: { start_mode: 'immediate' }, now,
  });
  assert.equal(result.existing.id, laterPaid.id);
  await assert.rejects(simulator.resolveRollingSimulationContext(db, {
    tenantId: 'tenant', memberId: 'member', config: { start_mode: 'immediate' },
    options: { previousTerm: history }, now,
  }), /Payment unverified/);
});

test('annual eligibility uses the later paid term, and holds a latest unknown before deriving its dates', async () => {
  let rows = [history, { ...laterPaid, billing_period: 'annual' }];
  const db = { from(table) {
    const query = {
      select() { return query; }, eq() { return query; }, neq() { return query; },
      order() { return query; }, limit() { return query; }, in() { return query; },
      then(resolve, reject) {
        return Promise.resolve({ data: table === 'member_membership_history' ? rows : [] }).then(resolve, reject);
      },
    };
    return query;
  } };
  const options = { tenantId: 'tenant', memberId: 'member',
    config: { billing_period: 'annual', renewal_open_days: 30, renewal_grace_days: 7 },
    membershipYear: { label: '2027/2028', start: '2027-01-01', end: '2027-12-31' },
    now: new Date('2026-12-15T00:00:00Z') };
  const allowed = await resolveEntityAnnualRenewalEligibility(db, options);
  assert.equal(allowed.eligible, true);
  assert.equal(allowed.lifecycle.currentTermEnd, laterPaid.term_end_date);
  rows = [...rows, { ...history, id: 'latest-unknown', membership_year: '2027/2028' }];
  const held = await resolveEntityAnnualRenewalEligibility(db, options);
  assert.equal(held.eligible, false);
  assert.equal(held.code, 'MEMBERSHIP_PAYMENT_UNVERIFIED');
});

test('unverified history cannot become a current commitment, even with stray financial/term fields', () => {
  const row = { ...history, term_key: 'rolling:2026-01-01',
    term_start_date: '2026-01-01', term_end_date: '2026-12-31',
    membership_renewal_date: '2027-01-01', commitment_snapshot: { amounts: { final_cost: 100 } } };
  assert.equal(shapePersistedCommitment(row, now), null);
  assert.deepEqual(shapePersistedCommitments([row], now), []);
  assert.equal(shapeLegacyCurrentMembership(row, row.tenant_id, now), null);
  assert.equal(selectCanvasCommitment([row], [], '2026-06-01'), null);
  assert.equal(isCurrentMembershipProtection(row, now), false);
});

test('unknown and zero historical prices are not paid activation authority', async () => {
  for (const total of [null, 0, 100]) {
    const result = await runScheduledActivation({
      row: { ...history, status: 'scheduled', total_with_vat: total, paid_at: now.toISOString() },
      tenantId: 'tenant', scope: 'member', now, effects: { perform: deny },
    });
    assert.equal(result.skipped, true);
    assert.match(result.reason, /unverified/i);
  }
});

test('unverified history exposes unknown prices, not money or a dynamic collection quote', async () => {
  const row = { ...history, final_cost: 100, total_with_vat: 120,
    billing_agreement_id: 'unexpected', payment_method: 'direct_debit',
    commitment_snapshot: { collection_policy: { pricing_policy: 'dynamic' } } };
  await enrichMembershipHistoryPrices([row], { db: { from: deny }, tenantId: 'tenant' });
  const price = getMembershipPricingPresentation(row);
  for (const key of ['agreed', 'net', 'gross', 'vat']) {
    assert.deepEqual(price[key], { amount: null, text: 'Unknown' });
  }
  assert.equal(price.monthly, null);
  assert.equal(price.signupMonthly, null);
});

test('reconciliation cannot convert unverified history to paid or fire workflows', async () => {
  const result = await reconcileRow({
    table: 'member_membership_history',
    row: { ...history, accounting_invoice_id: 'unexpected', accounting_provider: 'xero' },
  }, { db: { from: deny }, fetchStatus: deny, fireWorkflow: deny });
  assert.match(JSON.stringify(result), /payment-unverified/);
});

test('unverified history cannot prepare a renewal reminder payment link', async () => {
  const result = await resolveReminderPaymentQuote({
    client: { from: deny }, tenantId: 'tenant', history, histories: [history],
    now, simulate: deny, prepare: deny,
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'MEMBERSHIP_PAYMENT_UNVERIFIED');
});

test('annual renewal gate rejects both uncertain predecessors and uncertain target terms', () => {
  for (const options of [{ previousRecord: history }, { existingTargetRecord: history }]) {
    const result = classifyAnnualRenewal(options);
    assert.equal(result.eligible, false);
    assert.equal(result.code, 'MEMBERSHIP_PAYMENT_UNVERIFIED');
  }
});

test('backend simulator rejects unverified member history before resolving prices', async () => {
  const db = { from(table) {
    assert.ok(['member', 'member_membership_history'].includes(table));
    const query = {
      select() { return query; }, eq() { return query; },
      maybeSingle: async () => ({ data: { id: 'member', tenant_id: 'tenant' } }),
      then(resolve, reject) { return Promise.resolve({ data: [history] }).then(resolve, reject); },
    };
    return query;
  } };
  const result = await createMembershipSimulator(db, () => now)
    .simulateMembershipForMember('tenant', 'member');
  assert.equal(result.success, false);
  assert.equal(result.code, 'MEMBERSHIP_PAYMENT_UNVERIFIED');
});

test('member API retains the history but offers no live-price substitute or renewal actions', async () => {
  const db = { from(table) {
    const rows = table === 'member' ? [{ id: 'member', tenant_id: 'tenant' }]
      : table === 'member_membership_history' ? [history] : [];
    const query = {
      select() { return query; }, eq() { return query; }, order() { return query; },
      in() { return query; }, is() { return query; }, limit() { return query; },
      maybeSingle: async () => ({ data: rows[0] || null, error: null }),
      then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); },
    };
    return query;
  } };
  const handler = createMemberMembershipHandler({
    db, getTenantContext: async () => ({ tenantId: 'tenant' }),
    getSessionMember: async () => ({ id: 'member', tenant_id: 'tenant' }),
    hasAdminAccess: async () => true,
    getConfigForMember: deny, simulateMembershipForMember: deny,
    enrichMembershipHistoryPrices: async () => {}, getNow: () => now,
  });
  let payload;
  let status = 200;
  await handler({ method: 'GET', query: { memberId: 'member' } }, {
    status(value) { status = value; return this; },
    json(value) { payload = value; return value; },
  });
  assert.equal(status, 200);
  assert.equal(payload.history[0].payment_status, 'unverified');
  assert.equal(payload.config, null);
  assert.equal(payload.currentYearCost, null);
  assert.equal(payload.nextYearPreview, null);
  assert.deepEqual(payload.currentCommitments, []);
  assert.equal(payload.pricingCapability.canRenew, false);
  assert.equal(payload.pricingCapability.canInvoice, false);
});

test('member API does not lock independently verified later paid membership behind old unknown history', async () => {
  const db = { from(table) {
    const rows = table === 'member' ? [{ id: 'member', tenant_id: 'tenant' }]
      : table === 'member_membership_history' ? [history, laterPaid] : [];
    const query = {
      select() { return query; }, eq() { return query; }, order() { return query; },
      in() { return query; }, is() { return query; }, limit() { return query; },
      maybeSingle: async () => ({ data: rows[0] || null, error: null }),
      then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); },
    };
    return query;
  } };
  let configReads = 0;
  const handler = createMemberMembershipHandler({
    db, getTenantContext: async () => ({ tenantId: 'tenant' }),
    getSessionMember: async () => ({ id: 'member', tenant_id: 'tenant' }),
    hasAdminAccess: async () => true,
    getConfigForMember: async () => { configReads++; return null; },
    getAllActiveConfigs: async () => [],
    getConfigByIdDirect: async () => null,
    simulateMembershipForMember: deny, enrichMembershipHistoryPrices: async () => {},
    getNow: () => now,
  });
  let payload;
  let status = 200;
  await handler({ method: 'GET', query: { memberId: 'member' } }, {
    status(value) { status = value; return this; }, json(value) { payload = value; return value; },
  });
  assert.equal(status, 200);
  assert.equal(configReads, 1);
  assert.notEqual(payload.pricingCapability.status, 'payment_unverified');
  assert.equal(payload.currentCommitments[0].id, laterPaid.id);
  assert.equal(payload.history.find(row => row.id === history.id).payment_status, 'unverified');
});

test('invoice retry and public payment reject before queue/provider handling; UI uses explicit label', async () => {
  const retry = await readFile(new URL('../admin/membership-invoice-retry.js', import.meta.url), 'utf8');
  assert.ok(retry.indexOf("row.payment_status === 'unverified'") < retry.indexOf('const queued = await resumeAccountingSource'));
  const token = await readFile(new URL('../public/membership-fees/[token].js', import.meta.url), 'utf8');
  assert.ok(token.indexOf("historicalPayment?.payment_status === 'unverified'") < token.indexOf('const invoiceReference = await resolveFeeTokenInvoiceReference'));
  const ui = await readFile(new URL('../../client/src/components/MemberMembershipTab.jsx', import.meta.url), 'utf8');
  assert.match(ui, /unverified: 'Payment unverified'/);
});

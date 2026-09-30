import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPaymentReportDirectDebit } from './membershipPaymentReportDirectDebit.js';
import { directDebitMembershipPresentation } from './directDebitMembershipPresentation.js';
import { membershipPaymentReportCsv } from './membershipPaymentReportCsv.js';

const member = { id: 'm', tenant_id: 't' };
const old = { id: 'old', tenant_id: 't', name: 'Original structure', dd_enabled: true,
  structure_scope_type: 'member', start_mode: 'immediate', pricing_model: 'flat', currency: 'GBP', dd_monthly_amount: 10 };
const agreement = { id: 'a', tenant_id: 't', member_id: 'm', provider: 'gocardless', environment: 'live',
  status: 'active', gocardless_mandate_id: 'MD', metadata: { dd: {
    collection_policy: { version: 1, pricing_policy: 'dynamic', end_policy: 'stop' },
    invoicing_mode: 'per_instalment', currency: 'GBP',
    commitment: { term_key: 'term', commitment_snapshot: { config: old } },
  } } };
const plan = { id: 'p', tenant_id: 't', member_id: 'm', billing_agreement_id: 'a', provider: 'gocardless',
  environment: 'live', status: 'first_payment_pending', gocardless_mandate_id: 'MD',
  dynamic_next_collection_date: '2026-10-01', metadata: { collection_mode: 'dynamic' } };
const history = { id: 'h', tenant_id: 't', member_id: 'm', billing_agreement_id: 'a',
  membership_source: 'personal', status: 'active', payment_method: 'gocardless', billing_period: 'monthly',
  term_key: 'term', term_start_date: '2026-01-01', term_end_date: '2026-12-31', membership_renewal_date: '2027-01-01' };
const payment = { id: 'pay', tenant_id: 't', plan_id: 'p', billing_agreement_id: 'a', environment: 'live',
  gocardless_payment_id: 'PM', gocardless_mandate_id: 'MD', status: 'submitted', charge_date: '2026-10-05',
  amount_minor: 2400, currency: 'GBP' };
const input = patch => ({ tenantId: 't', today: '2026-09-25', members: [member], agreements: [agreement],
  plans: [plan], payments: [], ...patch });
const loadPresentations = async (db, tenant, plans, today) => new Map(plans.map(p => [
  p.id, directDebitMembershipPresentation(p, [history], member, today),
]));
const future = { ...old, id: 'future', name: 'October structure', dd_monthly_amount: 24 };
function dbFor(configs = [future]) {
  return { from(table) {
    assert.ok(['membership_tier_config', 'membership_tier_band', 'membership_tier_vat_override'].includes(table));
    const filters = [];
    return {
      select() { return this; }, order() { return this; },
      eq(key, value) { filters.push(r => r[key] === value); return this; },
      or(expression) {
        const [, field, operator, date] = expression.match(/,([^.]+)\.(lte|gte)\.(.+)$/);
        filters.push(r => !r[field] || (operator === 'lte' ? r[field] <= date : r[field] >= date));
        return this;
      },
      then(resolve, reject) {
        return Promise.resolve({ data: (table === 'membership_tier_config' ? configs : []).filter(r => filters.every(f => f(r))), error: null }).then(resolve, reject);
      },
    };
  } };
}
const load = (patch = {}, deps = {}) => loadPaymentReportDirectDebit(input(patch),
  { db: dbFor(), loadPresentations, ...deps }).then(rows => rows.get('p'));

test('same dated entitlement authority as DD admin, not pending local setup status', async () => {
  const row = await load();
  assert.equal(row.status, 'current');
  assert.equal(row.nextPaymentAmount, 24);
  assert.equal(row.nextStructureName, 'October structure');
  assert.match(row.nextPaymentAmountState, /not yet bank scheduled/);
});

test('next due date selects effective dynamic structure using canonical collector price', async () => {
  const row = await load({}, { db: dbFor([{ ...old, effective_to: '2026-09-30' },
    { ...future, effective_from: '2026-10-01' }]) });
  assert.equal(row.nextPaymentAmount, 24);
  assert.equal(row.nextStructureName, 'October structure');
  const overlap = await load({}, { db: dbFor([old, future]) });
  assert.equal(overlap.nextPaymentAmount, null);
  assert.match(overlap.nextPaymentAmountState, /Review required/);
});

test('bulk report snapshot has identical pricing and scope checks without repeated DB reads', async () => {
  const configs = [{ ...old, effective_to: '2026-09-30' }, { ...future, effective_from: '2026-10-01' },
    { ...future, tenant_id: 'foreign', dd_monthly_amount: 999 }];
  const ordinary = await load({}, { db: dbFor(configs) });
  const bulk = await load({ configs, bands: [], vatRules: [] },
    { db: { from() { throw Error('no repeated pricing query expected'); } } });
  assert.deepEqual(bulk, ordinary);
});

test('new joiners and historical members without entitlement are not relabelled Current', async () => {
  const noEntitlement = await load({}, {
    loadPresentations: async () => new Map([['p', directDebitMembershipPresentation(plan, [], member, '2026-09-25')]]),
  });
  assert.equal(noEntitlement.status, 'first_payment_pending');
  assert.equal(noEntitlement.statusLabel, 'Awaiting first payment');
  const imported = await load({}, {
    loadPresentations: async () => new Map([['p', directDebitMembershipPresentation(plan, [], member, '2026-09-25', { source: 'canonical adoption' })]]),
  });
  assert.equal(imported.status, 'membership_unverified');
  assert.equal(imported.statusLabel, 'Membership status unverified');
});

test('provider payment amount and immutable submitted structure beat edited price', async () => {
  const row = await load({ payments: [payment], reservations: [{
    tenant_id: 't', plan_id: 'p', billing_agreement_id: 'a', environment: 'live', gocardless_payment_id: 'PM',
    price_snapshot: { config: { name: 'Submitted structure' } },
  }] }, { resolvePrice: () => { throw new Error('must not reprice submitted payment'); } });
  assert.equal(row.nextPaymentAmount, 24);
  assert.equal(row.nextStructureName, 'Submitted structure');
  assert.equal(row.nextPaymentAmountState, 'Provider-scheduled payment');
});

test('paused/cancelled never schedule; holds retain Current entitlement with explicit configured basis', async () => {
  for (const status of ['paused', 'cancelled', 'completed']) {
    const row = await load({ plans: [{ ...plan, status }] });
    assert.equal(row.status, status);
    assert.equal(row.nextPaymentAmount, null);
    assert.equal(row.nextPaymentAmountState, 'Not scheduled');
  }
  const held = await load({ plans: [{ ...plan, collection_stopped_at: '2026-09-01' }] });
  assert.equal(held.status, 'current');
  assert.equal(held.nextPaymentAmount, 24);
  assert.match(held.nextPaymentAmountState, /held/);
  assert.match(held.paymentArrangement, /held/);
});

test('owner/environment isolation, stale and ambiguous payments fail closed', async () => {
  for (const patch of [{ member_id: 'other' }, { tenant_id: 'other' }, { environment: 'sandbox' }, { organization_id: 'org' }]) {
    assert.equal(await load({ plans: [{ ...plan, ...patch }] }), undefined);
  }
  const stale = await load({ plans: [{ ...plan, dynamic_next_collection_date: '2026-09-01' }] });
  assert.equal(stale.nextPaymentAmount, null);
  for (const patch of [{ environment: 'sandbox' }, { billing_agreement_id: 'other' }, { gocardless_mandate_id: 'other' }]) {
    const row = await load({ payments: [{ ...payment, ...patch, amount_minor: 99999 }] });
    assert.equal(row.nextPaymentAmount, 24);
    assert.match(row.nextPaymentAmountState, /Projected/);
  }
  assert.equal((await load({ payments: [payment, { ...payment, id: 'duplicate' }] })).nextPaymentAmount, null);
});

test('fixed plan uses committed structure and configured amount including genuine zero; CSV matches', async () => {
  const row = await load({ plans: [{ ...plan, metadata: {}, amount_minor: 0, currency: 'EUR' }] });
  assert.equal(row.nextPaymentAmount, 0);
  assert.equal(row.nextStructureName, 'Original structure');
  const csv = membershipPaymentReportCsv([{ ...row, name: 'Member', paymentMethod: 'monthly_direct_debit' }], 'monthly_direct_debit');
  assert.match(csv, /Next payment amount,Currency,Payment amount basis/);
  assert.match(csv, /0.00,EUR,Configured plan amount/);
  assert.doesNotMatch(membershipPaymentReportCsv([], 'upfront'), /Payment amount basis/);
});
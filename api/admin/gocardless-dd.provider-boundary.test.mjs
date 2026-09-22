import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePost, handleCollectionDayAction, listPlans, buildSummary, planDetail } from './gocardless-dd.js';
import { filterConsoleRows, filterDirectDebitRows } from '../_lib/directDebitConsoleEligibility.js';

const response = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
function fixture(planProvider, agreementProvider) {
  const agreement = { id: 'agreement', tenant_id: 'tenant', member_id: 'member', provider: agreementProvider };
  const plan = { id: 'plan', tenant_id: 'tenant', member_id: 'member', billing_agreement_id: agreement.id,
    provider: planProvider, status: 'payment_overdue', membership_billing_agreements: agreement };
  const tables = {
    membership_payment_plans: [plan], membership_billing_agreements: [agreement],
    member: [{ id: 'member', tenant_id: 'tenant', email: 'valid@example.test' }],
  };
  const db = {
    from(table) {
      const filters = [];
      const rows = () => (tables[table] || []).filter(r => filters.every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
      return {
        select() { return this; }, order() { return this; },
        eq(k, v) { filters.push([k, v]); return this; }, in(k, v) { filters.push([k, v]); return this; },
        async range(start, end) { return { data: rows().slice(start, end + 1) }; },
        async maybeSingle() { return { data: rows()[0] || null }; },
        then(resolve) { resolve({ data: rows() }); },
        update() { assert.fail('No database update allowed'); },
        insert() { assert.fail('No audit mutation allowed'); },
      };
    },
    rpc() { assert.fail('No RPC mutation allowed'); },
  };
  return { db, plan };
}
const invalidProviders = [
  ['stripe', 'stripe'], [undefined, 'gocardless'], ['gocardless', undefined],
  [null, null], ['stripe', 'gocardless'], ['gocardless', 'stripe'],
];
const actions = ['manual_activate', 'retry', 'refund', 'cancel_subscription', 'pause_subscription',
  'resume_subscription', 'reconcile', 'cancel_mandate', 'extend_grace', 'manual_resolve',
  'remind', 'new_mandate_link', 'note'];

test('every actual DD plan action rejects non-DD or unproven canonical providers before mutation or provider access', async () => {
  for (const providers of invalidProviders) {
    for (const action of actions) {
      const { db } = fixture(...providers), res = response();
      await handlePost({ body: { action, planId: 'plan', note: 'reviewed', paymentId: 'payment', amountMinor: 100, days: 7 } },
        res, 'tenant', 'admin@example.test', { db, getProvider: () => assert.fail('No provider access') });
      assert.equal(res.statusCode, 404, `${action}: ${providers}`);
      assert.equal(res.body.error, 'Plan not found');
    }
  }
});

test('both actual collection-day actions reject invalid provider ownership before provider/RPC access', async () => {
  for (const providers of invalidProviders) {
    for (const action of ['preview_collection_day', 'change_collection_day']) {
      const { db } = fixture(...providers), res = response();
      await handleCollectionDayAction({ method: 'POST', body: { action, planId: 'plan', day: 1 } }, res, {
        db, getContext: async () => ({ tenantId: 'tenant' }), adminAccess: async () => true,
        gc: { getMandate() { assert.fail('No provider read'); } },
      });
      assert.equal(res.statusCode, 404);
    }
  }
});

test('DD list, summary/attention and detail never expose non-DD or unproven plans', async () => {
  for (const providers of invalidProviders) {
    const { db } = fixture(...providers);
    assert.equal((await listPlans('tenant', {}, db)).total, 0);
    const summary = await buildSummary('tenant', { db });
    assert.deepEqual(summary.byStatus, {});
    assert.deepEqual(summary.attention, []);
    const res = response();
    assert.deepEqual(await planDetail('tenant', 'plan', res, { db }), { error: 'Plan not found' });
    assert.equal(res.statusCode, 404);
  }
});

test('valid GoCardless records remain visible while renewal identity filtering stays dual-provider', async () => {
  const { db, plan } = fixture('gocardless', 'gocardless');
  assert.deepEqual(await filterDirectDebitRows(db, 'tenant', [plan], { plans: true }), [plan]);
  assert.equal((await listPlans('tenant', {}, db)).total, 1);
  assert.equal((await buildSummary('tenant', { db })).attention.length, 1);
  const stripe = fixture('stripe', 'stripe');
  const renewal = { member_id: 'member', previous_agreement_id: 'agreement' };
  assert.deepEqual(await filterConsoleRows(stripe.db, 'tenant', [renewal]), [renewal]);
});
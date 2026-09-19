import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStripeCollectionSchedule } from './membershipCollectionSchedule.js';

const timestamp = (date) => Date.parse(`${date}T00:00:00Z`) / 1000;
const agreement = { id: 'agreement', tenant_id: 'tenant', provider: 'stripe', environment: 'test',
  stripe_customer_id: 'cus_saved', stripe_subscription_id: 'sub_saved' };
const plan = { id: 'plan', tenant_id: 'tenant', provider: 'stripe', billing_agreement_id: 'agreement',
  stripe_subscription_id: 'sub_saved', environment: 'test' };
const subscription = { id: 'sub_saved', customer: 'cus_saved', livemode: false, status: 'active',
  collection_method: 'charge_automatically',
  billing_cycle_anchor: timestamp('2026-01-31'), current_period_end: timestamp('2026-02-28'),
  items: { data: [{ price: { recurring: { interval: 'month', interval_count: 1 } } }] } };
function setup(overrides = {}) {
  const calls = [];
  const args = { tenantId: 'tenant', agreement, plan, now: new Date('2026-02-01'),
    getCredentials: async (tenantId) => {
      calls.push(['credentials', tenantId]);
      return { secret_key: 'live-fixture', test_secret_key: 'test-fixture', stripe_mode_membership: 'live' };
    },
    createClient: async (key) => {
      calls.push(['client', key]);
      return { subscriptions: { retrieve: async (id) => { calls.push(['retrieve', id]); return subscription; } } };
    }, ...overrides };
  return { args, calls };
}

test('Stripe uses tenant credentials and recorded mode, distinguishing regular day from provider date', async () => {
  const { args, calls } = setup();
  const result = await loadStripeCollectionSchedule(args);
  assert.equal(result.regularDay, 31);
  assert.equal(result.nextConfirmedDate, '2026-02-28');
  assert.equal(result.canEdit, false);
  assert.match(result.reason, /read-only in this feature/);
  assert.deepEqual(calls, [['credentials', 'tenant'], ['client', 'test-fixture'], ['retrieve', 'sub_saved']]);
  assert.equal(JSON.stringify(result).includes('fixture'), false);
});

for (const patch of [
  { agreement: { ...agreement, tenant_id: 'other' } },
  { plan: { ...plan, tenant_id: 'other' } },
  { plan: { ...plan, billing_agreement_id: 'other' } },
  { agreement: { ...agreement, environment: null } },
  { plan: { ...plan, environment: 'live' } },
  { plan: { ...plan, stripe_subscription_id: 'sub_other' } },
]) {
  test(`Stripe rejects inconsistent saved evidence ${JSON.stringify(patch)}`, async () => {
    const { args, calls } = setup(patch);
    const result = await loadStripeCollectionSchedule(args);
    assert.equal(result.evidence, 'unavailable');
    assert.equal(result.regularDay, null);
    assert.equal(result.nextConfirmedDate, null);
    assert.deepEqual(calls, []);
  });
}

test('missing recorded-mode credentials never falls back to the other mode', async () => {
  const { args, calls } = setup({ getCredentials: async () => ({ secret_key: 'live-fixture' }) });
  assert.equal((await loadStripeCollectionSchedule(args)).evidence, 'unavailable');
  assert.deepEqual(calls, []);
});

test('provider errors remain unknown and do not expose raw provider error text', async () => {
  const { args } = setup({ createClient: async () => { throw new Error('private upstream details'); } });
  const result = await loadStripeCollectionSchedule(args);
  assert.equal(result.evidence, 'unavailable');
  assert.equal(result.regularDay, null);
  assert.doesNotMatch(result.reason, /private/);
});

for (const patch of [
  { livemode: true }, { customer: 'cus_other' }, { id: 'sub_other' },
  { items: { data: [{ price: { recurring: { interval: 'year', interval_count: 1 } } }] } },
]) {
  test(`rejects unrelated/nonmonthly provider evidence ${JSON.stringify(patch)}`, async () => {
    const { args } = setup({ createClient: async () => ({
      subscriptions: { retrieve: async () => ({ ...subscription, ...patch }) },
    }) });
    assert.equal((await loadStripeCollectionSchedule(args)).evidence, 'unavailable');
  });
}

for (const patch of [
  { status: 'canceled' }, { cancel_at_period_end: true },
  { collection_method: 'send_invoice' },
  { cancel_at: timestamp('2026-02-28') }, { pause_collection: { behavior: 'void' } },
  { current_period_end: timestamp('2026-01-31') },
]) {
  test(`does not promise a next charge for stopped/stale schedule ${JSON.stringify(patch)}`, async () => {
    const { args } = setup({ createClient: async () => ({
      subscriptions: { retrieve: async () => ({ ...subscription, ...patch }) },
    }) });
    const result = await loadStripeCollectionSchedule(args);
    assert.equal(result.nextConfirmedDate, null);
    assert.equal(result.canEdit, false);
  });
}

test('modern item period and explicit anchor configuration preserve nominated month-end', async () => {
  const { args } = setup({ createClient: async () => ({
    subscriptions: { retrieve: async () => ({ ...subscription, current_period_end: undefined,
      billing_cycle_anchor: timestamp('2026-02-28'), billing_cycle_anchor_config: { day_of_month: 31 },
      items: { data: [{ ...subscription.items.data[0], current_period_end: timestamp('2026-03-31') }] } }) },
  }) });
  const result = await loadStripeCollectionSchedule(args);
  assert.equal(result.regularDay, 31);
  assert.equal(result.nextConfirmedDate, '2026-03-31');
});
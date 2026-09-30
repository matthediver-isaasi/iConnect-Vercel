import test from 'node:test';
import assert from 'node:assert/strict';
import { shapePlan } from './payment-plan.js';

const plan = {
  id: 'plan', provider: 'gocardless', amount_minor: 1066, currency: 'GBP',
  membership_billing_agreements: { metadata: { dd: {
    collection_policy: { version: 1, end_policy: 'continue', pricing_policy: 'dynamic' },
  } } },
};

test('dynamic plan cannot advertise its opening amount as the next planned charge', () => {
  const result = shapePlan(plan);
  assert.equal(result.monthlyAmount, null);
  assert.equal(result.nextPlannedCollectionAmount, null);
  assert.equal(result.collectionPolicy.end_policy, 'continue');
  assert.equal(result.collectionPolicy.pricing_policy, 'dynamic');
});

test('existing Stripe plan amounts and arrears behaviour remain unchanged', () => {
  const result = shapePlan({
    ...plan, provider: 'stripe',
    membership_monthly_arrears_period: [{ amount_minor: 1200, settled_at: null }],
    membership_billing_agreements: { metadata: { card: {
      monthly_post_grace_collection_policy: 'continue_catch_up',
    } } },
  });
  assert.equal(result.monthlyAmount, 10.66);
  assert.equal(result.nextPlannedCollectionAmount, 22.66);
  assert.equal(Object.hasOwn(result, 'collectionPolicy'), false);
});

test('catch-up arithmetic never fabricates a missing base amount', () => {
  const result = shapePlan({
    ...plan, provider: 'stripe', amount_minor: null,
    membership_monthly_arrears_period: [
      { amount_minor: 1200, settled_at: null },
      { amount_minor: null, settled_at: null },
    ],
    membership_billing_agreements: { metadata: { card: {
      monthly_post_grace_collection_policy: 'continue_catch_up',
    } } },
  });
  assert.equal(result.monthlyAmount, null);
  assert.equal(result.arrearsAmount, null);
  assert.equal(result.nextPlannedCollectionAmount, null);
});

test('explicit legacy stop differs from absent consent and neither becomes dynamic', () => {
  const legacy = (dd) => shapePlan({
    ...plan, membership_billing_agreements: { metadata: { dd } },
  });
  assert.equal(legacy({ auto_renew: false }).collectionPolicy.end_policy, 'stop');
  assert.equal(legacy({ auto_renew: true }).collectionPolicy.end_policy, 'continue');
  assert.equal(legacy({}).collectionPolicy.end_policy, null);
  assert.equal(legacy({}).collectionPolicy.needs_review, true);
  assert.equal(legacy({}).collectionPolicy.pricing_policy, 'fixed');
});
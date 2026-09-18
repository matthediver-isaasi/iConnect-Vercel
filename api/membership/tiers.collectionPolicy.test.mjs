import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDdCollectionPolicy, ddConfigFields } from './tiers.js';

for (const end of ['stop', 'continue']) {
  for (const pricing of ['fixed', 'dynamic']) {
    test(`validates and preserves ${end}/${pricing} without changing Stripe or arrears`, () => {
      const config = {
        dd_enabled: true, dd_policy_version: 1, dd_collection_end_policy: end,
        dd_pricing_policy: pricing, dd_invoicing_mode: 'per_instalment',
        dd_auto_renew: false, monthly_post_grace_collection_policy: 'continue_catch_up',
      };
      assert.equal(validateDdCollectionPolicy(config).ok, true);
      const saved = ddConfigFields(config);
      assert.equal(saved.dd_policy_version, 1);
      assert.equal(saved.dd_collection_end_policy, end);
      assert.equal(saved.dd_pricing_policy, pricing);
      assert.equal(saved.dd_auto_renew, false);
      assert.equal(saved.monthly_post_grace_collection_policy, 'continue_catch_up');
    });
  }
}

test('dynamic requires an explicitly selected per-instalment mode', () => {
  const config = { dd_enabled: true, dd_policy_version: 1, dd_collection_end_policy: 'continue', dd_pricing_policy: 'dynamic' };
  assert.equal(validateDdCollectionPolicy(config).field, 'dd_invoicing_mode');
  assert.equal(validateDdCollectionPolicy({ ...config, dd_invoicing_mode: 'annual' }).field, 'dd_invoicing_mode');
});

test('invalid and missing policies fail validation, not silently defaulted', () => {
  assert.equal(validateDdCollectionPolicy({ dd_enabled: true }).field, 'dd_policy_version');
  assert.equal(validateDdCollectionPolicy({ dd_enabled: true, dd_policy_version: 1, dd_collection_end_policy: 'forever' }).field, 'dd_collection_end_policy');
  assert.equal(validateDdCollectionPolicy({ dd_enabled: true, dd_policy_version: 1, dd_collection_end_policy: 'stop', dd_pricing_policy: 'cheap' }).field, 'dd_pricing_policy');
  assert.equal(validateDdCollectionPolicy({ dd_enabled: false }).ok, true);
  assert.equal(ddConfigFields({ dd_enabled: false }).dd_policy_version, null);
});
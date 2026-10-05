import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileMemberCardCheckout } from './reconcileMemberCardCheckout.js';

const agreement = { id: 'agreement', tenant_id: 'tenant', member_id: 'member',
  environment: 'test', stripe_checkout_session_id: 'cs_test' };
const session = { id: 'cs_test', status: 'complete', livemode: false,
  metadata: { tenant_id: 'tenant', member_id: 'member' } };

test('browser completion runs the webhook processor with original test-mode identity', async () => {
  let processed = 0;
  const result = await reconcileMemberCardCheckout({
    agreement, db: 'isolated-db', credentials: async () => ({ test_secret_key: 'fixture-test', secret_key: 'fixture-live' }),
    makeStripe: key => {
      assert.equal(key, 'fixture-test');
      return { checkout: { sessions: { retrieve: async () => session } } };
    },
    process: async (event, deps) => {
      processed++;
      assert.equal(event.type, 'checkout.session.completed');
      assert.equal(deps.expectedTenantId, 'tenant');
      assert.equal(deps.db, 'isolated-db');
      return { handled: true };
    },
  });
  assert.equal(processed, 1);
  assert.deepEqual(result, { confirmed: true });
});

for (const changed of [{ livemode: true }, { metadata: { tenant_id: 'other', member_id: 'member' } }]) {
  test(`browser completion rejects identity mismatch ${JSON.stringify(changed)}`, async () => {
    await assert.rejects(reconcileMemberCardCheckout({
      agreement, credentials: async () => ({ test_secret_key: 'fixture' }),
      makeStripe: () => ({ checkout: { sessions: { retrieve: async () => ({ ...session, ...changed }) } } }),
      process: () => assert.fail('must not process another identity'),
    }), /identity/);
  });
}

test('abandoned setup is not confirmed or released on return', async () => {
  assert.deepEqual(await reconcileMemberCardCheckout({
    agreement, credentials: async () => ({ test_secret_key: 'fixture' }),
    makeStripe: () => ({ checkout: { sessions: { retrieve: async () => ({ ...session, status: 'expired' }) } } }),
    process: () => assert.fail('not complete'),
  }), { confirmed: false });
});

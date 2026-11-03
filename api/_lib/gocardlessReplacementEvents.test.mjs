import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeReplacementEvent } from './gocardlessReplacementEvents.js';
const provider = { version: 1, environment: 'sandbox', source: 'tenant',
  tenant_id: 'tenant', account_fingerprint: 'fixture-account' };
function fixture(overrides = {}) {
  const operation = { id: 'op', tenant_id: 'tenant', environment: 'sandbox',
    provider_context: provider, old_mandate_id: 'old', new_mandate_id: 'new',
    new_subscription_id: 'new-sub', status: 'completed', phase: 'complete',
    snapshot: { subscription: { id: 'old-sub' } }, ...overrides };
  const db = { from(table) {
    assert.equal(table, 'membership_mandate_replacements');
    let matches = false;
    return {
      select() { return this; },
      eq(field, value) { matches = (field === 'snapshot->subscription->>id'
        ? operation.snapshot.subscription.id : operation[field]) === value; return this; },
      order() { return this; }, limit() { return this; },
      async maybeSingle() { return { data: matches ? operation : null }; },
    };
  } };
  return { db, gc: { providerContext: provider } };
}
for (const status of ['switching', 'completed']) {
  for (const resource_type of ['mandates', 'subscriptions']) {
    test(`${status}: late old ${resource_type} cancellation cannot cancel successor`, async () => {
      const deps = fixture({ status, phase: status === 'switching' ? 'stop_intent' : 'complete' });
      const links = resource_type === 'mandates' ? { mandate: 'old' } : { subscription: 'old-sub' };
      const result = await routeReplacementEvent({ resource_type, action: 'cancelled', links }, deps);
      assert.equal(result.handled, true);
      assert.match(result.detail, /historical replacement/);
    });
  }
}
test('original cancellation during authorization still uses normal cancellation rules', async () => {
  assert.equal(await routeReplacementEvent({ resource_type: 'mandates', action: 'cancelled',
    links: { mandate: 'old' } }, fixture({ status: 'authorizing', phase: 'authorization' })), null);
});
test('new mandate cancellation after completion uses normal membership rules', async () => {
  assert.equal(await routeReplacementEvent({ resource_type: 'mandates', action: 'cancelled',
    links: { mandate: 'new' } }, fixture()), null);
});
test('late successor-created event never resets paid instalments', async () => {
  const result = await routeReplacementEvent({ resource_type: 'subscriptions', action: 'created',
    links: { subscription: 'new-sub' } }, fixture());
  assert.equal(result.handled, true);
});
test('provider account mismatch fails before suppressing any cancellation', async () => {
  const deps = fixture(); deps.gc.providerContext = { ...provider, account_fingerprint: 'other' };
  await assert.rejects(routeReplacementEvent({ resource_type: 'mandates', action: 'cancelled',
    links: { mandate: 'old' } }, deps), /account mismatch/);
});

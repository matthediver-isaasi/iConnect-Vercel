import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replacementEligibility, evaluateReplacementHandover } from './gocardlessMandateReplacementPolicy.js';
import { publicReplacement, replacementResponse, refreshReplacement } from './gocardlessMandateReplacement.js';

function eligibility() {
  return {
    member: { id: 'member', tenant_id: 'tenant', organization_id: 'affiliation' },
    today: '2026-11-03', environment: 'live',
    histories: [{
      id: 'history', member_id: 'member', tenant_id: 'tenant', billing_agreement_id: 'agreement',
      payment_method: 'direct_debit', status: 'active', term_start_date: '2026-01-01', term_end_date: '2026-12-31',
    }],
    agreements: [{
      id: 'agreement', member_id: 'member', tenant_id: 'tenant', agreement_type: 'member',
      provider: 'gocardless', environment: 'live', status: 'active', gocardless_mandate_id: 'old',
    }],
  };
}
test('eligibility uses current individual history, not organisational affiliation', () => {
  assert.equal(replacementEligibility(eligibility()).canStart, true);
});
for (const [field, value] of [['member_id', 'other'], ['tenant_id', 'other'],
  ['environment', 'sandbox'], ['provider', 'stripe'], ['organization_id', 'org']]) {
  test(`agreement ${field} mismatch cannot start`, () => {
    const input = eligibility(); input.agreements[0][field] = value;
    assert.equal(replacementEligibility(input).canStart, false);
  });
}
for (const [field, value] of [['term_end_date', '2025-12-31'], ['term_start_date', '2027-01-01'],
  ['payment_method', 'card'], ['status', 'pending_payment_setup']]) {
  test(`non-current/non-DD history ${field} hides action`, () => {
    const input = eligibility(); input.histories[0][field] = value;
    assert.equal(replacementEligibility(input).eligible, false);
  });
}
test('multiple current agreements require assistance, never latest-record selection', () => {
  const input = eligibility(); input.histories.push({ ...input.histories[0], id: 'another' });
  assert.equal(replacementEligibility(input).canStart, false);
});
function handover() {
  return {
    ownershipVerified: true, externalScheduler: false, sharedMandate: false, inventoryComplete: true,
    oldMandate: { id: 'old', status: 'active', scheme: 'bacs', links: { creditor: 'creditor' } },
    newMandate: { id: 'new', status: 'active', scheme: 'bacs', links: { creditor: 'creditor' }, next_possible_charge_date: '2026-11-10' },
    payments: [], subscriptions: [], remainingObligations: [], cutoff: '2026-11-03',
  };
}
test('fully enumerated annual zero-obligation candidate passes only the pure preflight', () => {
  assert.equal(evaluateReplacementHandover(handover()).safe, true);
});
for (const [field, value] of [['ownershipVerified', false], ['externalScheduler', true],
  ['sharedMandate', true], ['inventoryComplete', false], ['payments', undefined],
  ['subscriptions', undefined], ['remainingObligations', undefined]]) {
  test(`unsafe ${field} blocks handover`, () => {
    assert.equal(evaluateReplacementHandover({ ...handover(), [field]: value }).safe, false);
  });
}
for (const status of ['submitted', 'pending_submission', 'confirmed', 'failed', 'charged_back']) {
  test(`payment ${status} cannot be discarded during cutover`, () => {
    const input = handover(); input.payments = [{ status, links: { mandate: 'old' } }];
    assert.equal(evaluateReplacementHandover(input).safe, false);
  });
}
test('provider subscription ownership and original mandate must match', () => {
  const input = handover(); input.expectedSubscriptionId = 'expected';
  input.subscriptions = [{ id: 'external', status: 'active', links: { mandate: 'old' } }];
  assert.equal(evaluateReplacementHandover(input).safe, false);
});
test('replacement lead time may not silently move an existing due date', () => {
  const input = handover();
  input.remainingObligations = [{ amountMinor: 1000, currency: 'GBP', chargeDate: '2026-11-09' }];
  assert.equal(evaluateReplacementHandover(input).safe, false);
  input.remainingObligations[0].chargeDate = '2026-11-10';
  assert.equal(evaluateReplacementHandover(input).safe, true);
});
test('public state contains no bank, account, authorization URL or mandate identifiers', () => {
  assert.deepEqual(publicReplacement({ id: 'op', status: 'action_required', old_mandate_id: 'old',
    new_mandate_id: 'new', authorization_url: 'secret', provider_context: {} }), {
    id: 'op', status: 'action_required',
    message: 'Your mandate replacement needs assistance. Please contact your membership team before making another payment arrangement.',
  });
});
test('review-required operation cannot be resumed or duplicate-started', () => {
  const result = replacementResponse({ eligible: true, canStart: true,
    operation: { id: 'op', status: 'action_required', flow_id: 'flow', authorization_url: 'url' } });
  assert.equal(result.canStart, false);
  assert.equal(result.canResume, false);
});
test('refresh with missing or changed provider context fails before provider access', async () => {
  await assert.rejects(refreshReplacement({
    db: {}, gc: { providerContext: null }, operation: { status: 'authorizing', environment: 'live' },
  }), /account must be restored/);
});
test('review-required refresh does not mutate current collections or contact provider', async () => {
  const operation = { status: 'action_required' };
  assert.equal(await refreshReplacement({ db: {}, gc: {}, operation }), operation);
});

function refreshFixture({ status = 'fulfilled', mandateStatus = 'active', race = false } = {}) {
  const context = { version: 1, environment: 'live', source: 'tenant',
    tenant_id: 'tenant', account_fingerprint: 'test-only-fingerprint' };
  let row = { id: 'operation', tenant_id: 'tenant', status: 'authorizing',
    old_mandate_id: 'old', billing_request_id: 'request', version: 0,
    provider_context: context, environment: 'live' };
  const writes = [];
  const db = {
    from(table) {
      if (table === 'gocardless_replacement_release') return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      };
      assert.equal(table, 'membership_mandate_replacements', 'no agreement, plan or payment mutation');
      return {
        update(patch) { writes.push(patch); this.patch = patch; return this; },
        eq() { return this; }, select() { return this; },
        async maybeSingle() {
          if (race) return { data: null };
          row = { ...row, ...this.patch, version: row.version + 1 };
          return { data: row };
        },
      };
    },
  };
  const gc = {
    providerContext: context,
    async getBillingRequest() {
      return { id: 'request', status, metadata: { replacement_id: 'operation', tenant_id: 'tenant' },
        links: status === 'fulfilled' ? { mandate_request_mandate: 'new', customer: 'new-customer' } : {} };
    },
    async getMandate(id) { assert.equal(id, 'new'); return { id, status: mandateStatus }; },
  };
  return { db, gc, operation: row, writes };
}
test('verified candidate does not overwrite working identities or falsely finish handover', async () => {
  const fixture = refreshFixture();
  const result = await refreshReplacement(fixture);
  assert.equal(result.status, 'action_required');
  assert.equal(result.old_mandate_id, 'old');
  assert.equal(result.new_mandate_id, 'new');
  assert.equal(fixture.writes.length, 1);
});
test('pending candidate remains awaiting provider confirmation', async () => {
  const fixture = refreshFixture({ mandateStatus: 'pending_submission' });
  assert.equal((await refreshReplacement(fixture)).status, 'awaiting_confirmation');
});
test('abandoned authorization leaves current mandate and operation intact', async () => {
  const fixture = refreshFixture({ status: 'pending' });
  assert.equal(await refreshReplacement(fixture), fixture.operation);
  assert.deepEqual(fixture.writes, []);
});
test('cancelled candidate authorization is not cancellation of membership', async () => {
  const fixture = refreshFixture({ status: 'cancelled' });
  assert.equal((await refreshReplacement(fixture)).status, 'cancelled');
  assert.deepEqual(fixture.writes, [{ status: 'cancelled' }]);
});
test('unknown provider read outcome remains recoverable with no local success write', async () => {
  const fixture = refreshFixture();
  fixture.gc.getBillingRequest = async () => { throw new Error('timeout'); };
  await assert.rejects(refreshReplacement(fixture), /timeout/);
  assert.deepEqual(fixture.writes, []);
});
test('concurrent refresh does not overwrite the winner or continue with stale state', async () => {
  await assert.rejects(refreshReplacement(refreshFixture({ race: true })), /changed concurrently/);
});

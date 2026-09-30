import test from 'node:test';
import assert from 'node:assert/strict';

import { compensateRejectedEventCreditPayment } from './eventPaymentPolicyCompensation.js';
import { buildEventCreditSnapshotMetadata } from './eventPaymentPolicyCompensation.js';

const expected = {
  expectedIntentId: 'pi-1',
  tenantId: 'tenant-a',
  eventId: 'event-a',
  purchaserEmail: 'member@example.test',
};

function intent(overrides = {}) {
  return {
    id: 'pi-1',
    status: 'succeeded',
    receipt_email: 'member@example.test',
    metadata: { tenant_id: 'tenant-a', event_id: 'event-a' },
    ...overrides,
  };
}

test('strongly bound succeeded payment is refunded once', async () => {
  let refunds = 0;
  const result = await compensateRejectedEventCreditPayment({
    ...expected,
    paymentIntent: intent(),
    refundSucceeded: async () => { refunds += 1; },
  });
  assert.deepEqual(result, { ok: true, compensated: true, action: 'refunded' });
  assert.equal(refunds, 1);
});

test('authorized but uncaptured payment is cancelled instead of refunded', async () => {
  let cancellations = 0;
  const result = await compensateRejectedEventCreditPayment({
    ...expected,
    paymentIntent: intent({ status: 'requires_capture' }),
    cancelAuthorization: async () => { cancellations += 1; },
  });
  assert.equal(result.action, 'cancelled');
  assert.equal(cancellations, 1);
});

for (const [label, changed] of [
  ['intent', { id: 'pi-other' }],
  ['tenant', { metadata: { tenant_id: 'tenant-b', event_id: 'event-a' } }],
  ['event', { metadata: { tenant_id: 'tenant-a', event_id: 'event-b' } }],
  ['purchaser', { receipt_email: 'attacker@example.test' }],
]) {
  test(`does not refund an intent with mismatched ${label} binding`, async () => {
    let refunds = 0;
    const result = await compensateRejectedEventCreditPayment({
      ...expected,
      paymentIntent: intent(changed),
      refundSucceeded: async () => { refunds += 1; },
    });
    assert.equal(result.reason, 'unverified_binding');
    assert.equal(refunds, 0);
  });
}

test('allocation-bound payments require an exact allocation match', async () => {
  let refunds = 0;
  const result = await compensateRejectedEventCreditPayment({
    ...expected,
    allocationContext: {
      invitationId: 'invite-a',
      eventId: 'event-a',
      ticketTypeId: 'ticket-a',
      delegateEmail: 'delegate@example.test',
    },
    paymentIntent: intent(),
    refundSucceeded: async () => { refunds += 1; },
  });
  assert.equal(result.reason, 'unverified_binding');
  assert.equal(refunds, 0);
});

test('provider refund failure is returned visibly', async () => {
  const result = await compensateRejectedEventCreditPayment({
    ...expected,
    paymentIntent: intent(),
    refundSucceeded: async () => { throw new Error('provider down'); },
  });
  assert.equal(result.reason, 'provider_failure');
  assert.match(result.error, /provider down/);
});

test('caller-invented credits cannot trigger a refund without an exact intent snapshot', async () => {
  let refunds = 0;
  const paymentIntent = intent({
    metadata: {
      tenant_id: 'tenant-a',
      event_id: 'event-a',
      ...buildEventCreditSnapshotMetadata({
        voucherIds: ['voucher-original'],
        voucherOrderManual: false,
        trainingFundAmount: 5,
      }),
    },
  });
  const result = await compensateRejectedEventCreditPayment({
    ...expected,
    paymentIntent,
    expectedCreditSnapshot: {
      voucherIds: ['voucher-invented'],
      voucherOrderManual: false,
      trainingFundAmount: 5,
    },
    refundSucceeded: async () => { refunds += 1; },
  });
  assert.equal(result.reason, 'unverified_binding');
  assert.equal(refunds, 0);
});
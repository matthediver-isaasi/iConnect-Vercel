import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadEventPaymentPolicy,
  assertEventPaymentMethodsAllowed,
  EventPaymentPolicyError,
} from './eventPaymentPolicy.js';

function settingsClient({ rows = [], error = null } = {}) {
  const observed = { tenantId: null, keys: null };
  const query = {
    select() { return this; },
    eq(column, value) {
      assert.equal(column, 'tenant_id');
      observed.tenantId = value;
      return this;
    },
    in(column, value) {
      assert.equal(column, 'setting_key');
      observed.keys = value;
      return Promise.resolve({ data: rows, error });
    },
  };
  return {
    observed,
    client: {
      from(table) {
        assert.equal(table, 'system_settings');
        return query;
      },
    },
  };
}

test('policy loading is scoped to the authoritative tenant', async () => {
  const { client, observed } = settingsClient({
    rows: [{ setting_key: 'event_allow_voucher_payment', setting_value: 'false' }],
  });

  const policy = await loadEventPaymentPolicy(client, 'tenant-a');
  assert.equal(observed.tenantId, 'tenant-a');
  assert.deepEqual(observed.keys.sort(), [
    'event_allow_training_fund_payment',
    'event_allow_voucher_payment',
  ]);
  assert.deepEqual(policy, {
    allowVoucherPayment: false,
    allowTrainingFundPayment: true,
  });
});

test('setting read errors fail closed', async () => {
  const { client } = settingsClient({ error: new Error('database unavailable') });
  await assert.rejects(
    loadEventPaymentPolicy(client, 'tenant-a'),
    (error) => error instanceof EventPaymentPolicyError && error.statusCode === 503,
  );
});

test('missing or malformed setting query data fails closed', async () => {
  for (const data of [undefined, null, {}]) {
    const client = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return Promise.resolve({ data, error: null }); },
        };
      },
    };
    await assert.rejects(
      loadEventPaymentPolicy(client, 'tenant-a'),
      (error) => error instanceof EventPaymentPolicyError && error.statusCode === 503,
    );
  }
});

test('disabled methods are rejected before a caller can perform side effects', async () => {
  let sideEffects = 0;
  const attemptBooking = async (rows, request) => {
    const { client } = settingsClient({ rows });
    const policy = await loadEventPaymentPolicy(client, 'tenant-a');
    assertEventPaymentMethodsAllowed(policy, request);
    sideEffects += 1;
  };

  await assert.rejects(
    attemptBooking(
      [{ setting_key: 'event_allow_voucher_payment', setting_value: 'false' }],
      { voucherRequested: true },
    ),
    /Voucher payment is not enabled/,
  );
  assert.equal(sideEffects, 0);

  await assert.rejects(
    attemptBooking(
      [{ setting_key: 'event_allow_training_fund_payment', setting_value: false }],
      { trainingFundRequested: true },
    ),
    /Training fund payment is not enabled/,
  );
  assert.equal(sideEffects, 0);
});
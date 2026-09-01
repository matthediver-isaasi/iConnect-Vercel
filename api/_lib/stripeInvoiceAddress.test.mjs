import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureCheckoutBillingAddress,
  capturePaymentIntentBillingAddress,
  normalizeStripeBillingAddress,
  stripeInvoiceAddressFromSnapshot,
} from './stripeInvoiceAddress.js';

const address = {
  line1: ' 1 High Street ',
  line2: 'Suite 2',
  city: 'London',
  state: 'Greater London',
  postal_code: 'SW1A 1AA',
  country: 'gb',
};

test('normalizes a complete Stripe address deterministically for accounting', () => {
  const snapshot = normalizeStripeBillingAddress(address);
  assert.equal(snapshot.country, 'GB');
  assert.equal(
    stripeInvoiceAddressFromSnapshot(snapshot),
    '1 High Street\nSuite 2\nLondon, Greater London\nSW1A 1AA\nGB',
  );
});

test('rejects an incomplete Stripe address instead of falling back', () => {
  assert.throws(
    () => normalizeStripeBillingAddress({ line1: '1 High Street', country: 'GB' }),
    /incomplete/,
  );
});

test('PaymentIntent capture retrieves the payment method and updates Customer', async () => {
  const updates = [];
  const intentUpdates = [];
  const stripe = {
    paymentMethods: { retrieve: async (id) => ({ id, billing_details: { address } }) },
    paymentIntents: { update: async (...args) => intentUpdates.push(args) },
    customers: { update: async (...args) => updates.push(args) },
  };
  const snapshot = await capturePaymentIntentBillingAddress({
    stripe,
    paymentIntent: { id: 'pi_1', payment_method: 'pm_1', customer: 'cus_1' },
  });
  assert.equal(snapshot.postal_code, 'SW1A 1AA');
  assert.equal(intentUpdates[0][0], 'pi_1');
  assert.equal(
    JSON.parse(intentUpdates[0][1].metadata.invoice_address_snapshot).line1,
    '1 High Street',
  );
  assert.equal(updates[0][0], 'cus_1');
  assert.deepEqual(updates[0][1].address, {
    line1: '1 High Street',
    line2: 'Suite 2',
    city: 'London',
    state: 'Greater London',
    postal_code: 'SW1A 1AA',
    country: 'GB',
  });
});

test('PaymentIntent retries use the immutable Stripe metadata snapshot', async () => {
  let paymentMethodReads = 0;
  const stripe = {
    paymentMethods: { retrieve: async () => { paymentMethodReads += 1; throw new Error('must not read mutable source'); } },
    paymentIntents: { update: async () => { throw new Error('must not overwrite snapshot'); } },
    customers: { update: async () => ({ id: 'cus_1' }) },
  };
  const snapshot = normalizeStripeBillingAddress(address);
  const recovered = await capturePaymentIntentBillingAddress({
    stripe,
    paymentIntent: {
      id: 'pi_1',
      payment_method: 'pm_changed',
      customer: 'cus_1',
      metadata: { invoice_address_snapshot: JSON.stringify(snapshot) },
    },
  });
  assert.equal(recovered.formatted, snapshot.formatted);
  assert.equal(paymentMethodReads, 0);
});

test('Checkout capture uses verified customer_details and updates Customer', async () => {
  const updates = [];
  const snapshot = await captureCheckoutBillingAddress({
    stripe: { customers: { update: async (...args) => updates.push(args) } },
    session: { customer: 'cus_2', customer_details: { address } },
  });
  assert.equal(snapshot.line1, '1 High Street');
  assert.equal(updates[0][0], 'cus_2');
});
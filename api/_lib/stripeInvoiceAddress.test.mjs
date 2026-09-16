import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureCheckoutBillingAddress,
  capturePaymentIntentBillingAddress,
  hasStripeBillingAddressSnapshot,
  normalizeStripeBillingAddress,
  stripeBillingAddressSnapshotFromMetadata,
  stripeInvoiceAddressFromMetadata,
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

test('agreement metadata uses the canonical Checkout snapshot and preserves its normalized shape', () => {
  const canonical = {
    line1: '1 Canonical Road',
    city: 'London',
    postal_code: 'SW1A 1AA',
    country: 'GB',
  };
  assert.equal(
    stripeInvoiceAddressFromMetadata({
      card: {
        billing_address: {
          line1: '1 Legacy Road',
          city: 'London',
          postal_code: 'SW1A 1AA',
          country: 'GB',
        },
      },
      stripe_billing_address: canonical,
    }),
    '1 Canonical Road\nLondon\nSW1A 1AA\nGB',
  );
  assert.deepEqual(stripeBillingAddressSnapshotFromMetadata({
    stripe_billing_address: canonical,
  }), {
    ...canonical,
    line2: null,
    state: null,
    country: 'GB',
    formatted: '1 Canonical Road\nLondon\nSW1A 1AA\nGB',
  });
  assert.equal(hasStripeBillingAddressSnapshot({ stripe_billing_address: canonical }), true);
});

test('agreement metadata validates the legacy card snapshot when canonical data is absent', () => {
  const legacy = {
    line1: '1 Legacy Road',
    city: 'London',
    postal_code: 'SW1A 1AA',
    country: 'gb',
  };
  assert.equal(
    stripeInvoiceAddressFromMetadata({ card: { billing_address: legacy } }),
    '1 Legacy Road\nLondon\nSW1A 1AA\nGB',
  );
  assert.equal(hasStripeBillingAddressSnapshot({ card: { billing_address: legacy } }), true);
});

test('a present but invalid canonical snapshot fails closed and never falls back to legacy data', () => {
  assert.throws(
    () => stripeInvoiceAddressFromMetadata({
      stripe_billing_address: { line1: '1 Canonical Road', country: 'GB' },
      card: {
        billing_address: {
          line1: '1 Valid Legacy Road',
          city: 'London',
          postal_code: 'SW1A 1AA',
          country: 'GB',
        },
      },
    }),
    /incomplete/,
  );
});

test('agreement metadata with no address snapshot fails closed', () => {
  assert.throws(
    () => stripeInvoiceAddressFromMetadata({ card: {} }),
    /snapshot is missing/,
  );
});

test('PaymentIntent capture uses the immutable successful Charge and updates Customer', async () => {
  const updates = [];
  const stripe = {
    charges: { retrieve: async (id) => ({ id, billing_details: { address } }) },
    customers: { update: async (...args) => updates.push(args) },
  };
  const snapshot = await capturePaymentIntentBillingAddress({
    stripe,
    paymentIntent: { id: 'pi_1', latest_charge: 'ch_1', payment_method: 'pm_1', customer: 'cus_1' },
  });
  assert.equal(snapshot.postal_code, 'SW1A 1AA');
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

test('PaymentIntent capture keeps membership Customer strict but permits ordinary customerless charges', async () => {
  const stripe = {
    charges: { retrieve: async () => ({ billing_details: { address } }) },
    customers: { update: async () => { throw new Error('customer update must not run'); } },
  };
  await assert.rejects(
    capturePaymentIntentBillingAddress({
      stripe,
      paymentIntent: { id: 'pi_membership', latest_charge: 'ch_membership', customer: null },
    }),
    /no reusable Customer/,
  );
  const snapshot = await capturePaymentIntentBillingAddress({
    stripe,
    paymentIntent: { id: 'pi_form', latest_charge: 'ch_form', customer: null },
    requireCustomer: false,
  });
  assert.equal(snapshot.postal_code, 'SW1A 1AA');
});

test('PaymentIntent capture refuses mutable metadata or PaymentMethod fallbacks', async () => {
  const stripe = {
    charges: { retrieve: async () => { throw new Error('charge unavailable'); } },
    paymentMethods: { retrieve: async () => { throw new Error('must not read mutable source'); } },
    customers: { update: async () => ({ id: 'cus_1' }) },
  };
  await assert.rejects(() => capturePaymentIntentBillingAddress({
    stripe,
    paymentIntent: { id: 'pi_1', latest_charge: 'ch_1', payment_method: 'pm_changed', customer: 'cus_1' },
  }), /could not be retrieved/);
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
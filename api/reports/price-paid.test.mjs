import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGroupPricePaid } from './_pricePaid.js';

const standard = (values = {}) => ({
  _report_booking_source: 'standard',
  total_cost: 100,
  payment_method: 'card',
  stripe_payment_intent_id: 'pi_test',
  status: 'confirmed',
  ...values,
});

const complex = (values = {}) => ({
  _report_booking_source: 'complex',
  ticket_price: 100,
  payment_method: 'card',
  payment_status: 'paid',
  status: 'confirmed',
  ...values,
});

test('standard subtracts separately stored discounts and credits, but not account payment allocation', () => {
  assert.deepEqual(normalizeGroupPricePaid([
    standard({ discount_code_amount: 10, voucher_amount: 20, training_fund_amount: 5, account_amount: 65 }),
  ]), [{ price_paid: 65, price_paid_status: 'net' }]);
});

test('complex does not double deduct its already-applied code discount and does deduct genuine balance credits', () => {
  assert.deepEqual(normalizeGroupPricePaid([
    complex({ ticket_price: 90, discount_amount: 10, voucher_amount: 20, training_fund_amount: 5, account_balance_amount: 15 }),
  ]), [{ price_paid: 50, price_paid_status: 'net' }]);
});

test('free and fully credited bookings preserve a real zero', () => {
  assert.deepEqual(normalizeGroupPricePaid([
    standard({ total_cost: 0, payment_method: 'free' }),
    complex({ ticket_price: 25, voucher_amount: 25, payment_status: 'failed' }),
  ]), [
    { price_paid: 0, price_paid_status: 'net' },
    { price_paid: 0, price_paid_status: 'net' },
  ]);
});

test('rounding never moves a remainder onto a free or exact-price attendee', () => {
  const rows = normalizeGroupPricePaid([
    standard({ total_cost: 0 }),
    standard({ total_cost: 5 }),
    ...Array.from({ length: 3 }, () => standard({ total_cost: 10 / 3 })),
  ]);
  assert.equal(rows[0].price_paid, 0);
  assert.equal(rows[1].price_paid, 5);
  assert.equal(rows.reduce((sum, row) => sum + Math.round(row.price_paid * 100), 0), 1500);
});

test('invoice intentions are pending while missing source amounts are unavailable', () => {
  assert.deepEqual(normalizeGroupPricePaid([
    standard({ total_cost: 40, payment_method: 'public_invoice_po' }),
    complex({ ticket_price: 30, payment_method: 'invoice', payment_status: 'pending' }),
    standard({ total_cost: null }),
    complex({ ticket_price: undefined }),
  ]), [
    { price_paid: 40, price_paid_status: 'pending' },
    { price_paid: 30, price_paid_status: 'pending' },
    { price_paid: null, price_paid_status: 'unavailable' },
    { price_paid: null, price_paid_status: 'unavailable' },
  ]);
});

test('standard account liabilities and pending booking states are not presented as paid', () => {
  assert.deepEqual(normalizeGroupPricePaid([
    standard({ payment_method: 'account', account_amount: 100, stripe_payment_intent_id: null }),
    standard({ status: 'pending' }),
    standard({ payment_status: 'unpaid' }),
  ]), [
    { price_paid: 100, price_paid_status: 'pending' },
    { price_paid: 100, price_paid_status: 'pending' },
    { price_paid: 100, price_paid_status: 'pending' },
  ]);
});

test('positive standard card balance without persisted payment intent is unavailable', () => {
  assert.deepEqual(normalizeGroupPricePaid([
    standard({ stripe_payment_intent_id: null }),
    standard({ payment_status: 'failed' }),
    standard({ payment_status: 'unknown' }),
  ]), [
    { price_paid: 100, price_paid_status: 'unavailable' },
    { price_paid: 100, price_paid_status: 'unavailable' },
    { price_paid: 100, price_paid_status: 'unavailable' },
  ]);
});

test('complex settlement status guides paid, pending and failed values', () => {
  assert.deepEqual(normalizeGroupPricePaid([
    complex({ payment_method: 'invoice', payment_status: 'paid' }),
    complex({ payment_status: 'pending' }),
    complex({ payment_status: 'failed' }),
    complex({ payment_status: null }),
  ]), [
    { price_paid: 100, price_paid_status: 'net' },
    { price_paid: 100, price_paid_status: 'pending' },
    { price_paid: 100, price_paid_status: 'unavailable' },
    { price_paid: 100, price_paid_status: 'unavailable' },
  ]);
});

test('attendee allocations are not copied and fractional cents reconcile to the group total', () => {
  const rows = normalizeGroupPricePaid([
    standard({ total_cost: 10 / 3 }),
    standard({ total_cost: 10 / 3 }),
    standard({ total_cost: 10 / 3 }),
  ]);
  assert.deepEqual(rows.map(row => row.price_paid), [3.34, 3.33, 3.33]);
  assert.equal(rows.reduce((sum, row) => sum + row.price_paid, 0), 10);
});
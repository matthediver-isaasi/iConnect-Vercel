import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGroupPayment,
  normalizeGroupPricePaid,
  normalizeGroupTicketPrices,
} from './_pricePaid.js';

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

test('canonical standard totals cover full, partial and no code discounts', () => {
  assert.deepEqual(normalizeGroupPayment([
    standard({ ticket_price: 60, total_cost: 60, discount_code_amount: 60 }),
  ]), {
    ticketTotal: 60, totalAfterDiscount: 0, discount: 60,
    offerDiscount: 0, codeDiscount: 60, totalsStatus: 'available',
  });
  assert.deepEqual(normalizeGroupPayment([
    standard({ ticket_price: 60, total_cost: 60, discount_code_amount: 15 }),
    standard({ ticket_price: 40, total_cost: 30, discount_code_amount: 0 }),
  ]), {
    ticketTotal: 100, totalAfterDiscount: 75, discount: 25,
    offerDiscount: 10, codeDiscount: 15, totalsStatus: 'available',
  });
  assert.equal(normalizeGroupPayment([
    standard({ ticket_price: 60, total_cost: 60 }),
  ]).totalAfterDiscount, 60);
});

test('canonical pre-credit total ignores vouchers, funds, and account liabilities or credits', () => {
  assert.deepEqual(normalizeGroupPayment([
    standard({
      ticket_price: 100, total_cost: 100, discount_code_amount: 10,
      voucher_amount: 20, training_fund_amount: 5, account_amount: 65,
    }),
  ]), {
    ticketTotal: 100, totalAfterDiscount: 90, discount: 10,
    offerDiscount: 0, codeDiscount: 10, totalsStatus: 'available',
  });
  assert.deepEqual(normalizeGroupPayment([
    complex({
      ticket_price: 90, discount_amount: 10, voucher_amount: 20,
      training_fund_amount: 5, account_balance_amount: 15,
    }),
  ]), {
    ticketTotal: 100, totalAfterDiscount: 90, discount: 10,
    offerDiscount: 0, codeDiscount: 10, totalsStatus: 'available',
  });
});

test('complex groups reconstruct gross ticket values without double-subtracting codes', () => {
  const bookings = [
    complex({ ticket_class_id: 'a', ticket_price: 49.99, discount_amount: 10.01 }),
    complex({ ticket_class_id: 'a', ticket_price: 49.99, discount_amount: 0 }),
    complex({ ticket_class_id: 'b', ticket_price: 25, discount_amount: 0 }),
  ];
  assert.deepEqual(normalizeGroupPayment(bookings), {
    ticketTotal: 145, totalAfterDiscount: 124.98, discount: 20.02,
    offerDiscount: 0, codeDiscount: 20.02, totalsStatus: 'available',
  });
  assert.deepEqual(normalizeGroupTicketPrices(bookings), [60, 60, 25]);
});

test('canonical currency rounding is cent precise and always reconciles', () => {
  const totals = normalizeGroupPayment([
    standard({ ticket_price: 10.005, total_cost: 10.005, discount_code_amount: 0.335 }),
    standard({ ticket_price: 20.004, total_cost: 20.004, discount_code_amount: 0.334 }),
  ]);
  assert.deepEqual(totals, {
    ticketTotal: 30.01, totalAfterDiscount: 29.34, discount: 0.67,
    offerDiscount: 0, codeDiscount: 0.67, totalsStatus: 'available',
  });
  assert.equal(
    Math.round((totals.totalAfterDiscount + totals.discount) * 100),
    Math.round(totals.ticketTotal * 100),
  );
});

test('standard PO offer totals use immutable checkout snapshots for BOGO and bulk offers', () => {
  const poGroup = (gross, net, count) => Array.from({ length: count }, () => standard({
    payment_method: 'public_invoice_po',
    stripe_payment_intent_id: null,
    ticket_price: net / count,
    total_cost: net / count,
    purchaser_context: {
      classification: 'public_non_member',
      financial_snapshot: {
        gross_ticket_unit_amount: gross / count,
        gross_ticket_total_amount: gross,
      },
    },
  }));
  assert.deepEqual(normalizeGroupPayment(poGroup(200, 100, 2)), {
    ticketTotal: 200, totalAfterDiscount: 100, discount: 100,
    offerDiscount: 100, codeDiscount: 0, totalsStatus: 'available',
  });
  assert.deepEqual(normalizeGroupTicketPrices(poGroup(200, 100, 2)), [100, 100]);
  assert.deepEqual(normalizeGroupPayment(poGroup(400, 300, 4)), {
    ticketTotal: 400, totalAfterDiscount: 300, discount: 100,
    offerDiscount: 100, codeDiscount: 0, totalsStatus: 'available',
  });
});

test('legacy standard PO rows do not invent gross prices from mutable catalogues', () => {
  const rows = [
    standard({
      payment_method: 'public_invoice_po', stripe_payment_intent_id: null,
      ticket_price: 50, total_cost: 50,
      purchaser_context: { classification: 'public_non_member' },
    }),
    standard({
      payment_method: 'public_invoice_po', stripe_payment_intent_id: null,
      ticket_price: 50, total_cost: 50,
      purchaser_context: { classification: 'public_non_member' },
    }),
  ];
  assert.deepEqual(normalizeGroupPayment(rows), {
    ticketTotal: null, totalAfterDiscount: 100, discount: null,
    offerDiscount: null, codeDiscount: 0,
    totalsStatus: 'unavailable_gross_snapshot',
  });
  assert.deepEqual(normalizeGroupTicketPrices(rows), [null, null]);
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { cartConfigurationError, normalizeCartAnswer, priceCartLines, formatCartReceipt, cartQuantityError } from './formCart.js';

const id = '10000000-0000-4000-8000-000000000001';
const field = { id: 'cart', type: 'sales_cart', cart_version: 1, allowed_product_ids: [id], allowed_bundle_ids: [] };
const form = { form_type: 'standard', fields: [field, { id: 'pay', type: 'payment', price_field_id: 'cart' }] };
const answer = quantity => ({ version: 1, lines: [{ id, kind: 'product', quantity }] });
const item = { id, kind: 'product', name: 'Original name', description: 'Accepted description',
  unitPriceMinor: 101, taxTreatment: 'standard', taxRateBps: 2000, currency: 'GBP', remaining: 3, available: true };
test('bundle caps aggregate duplicate lines and do not restrict products', () => {
  const limited = { bundle_max_quantities: { [id]: 1 } };
  assert.equal(cartQuantityError(limited, answer(3)), null);
  assert.equal(cartQuantityError(limited, { version: 1, lines: [{ id, kind: 'bundle', quantity: 1 }] }), null);
  assert.match(cartQuantityError(limited, { version: 1, lines: Array(2).fill({ id, kind: 'bundle', quantity: 1 }) }), /maximum of 1/);
  assert.match(cartConfigurationError({ ...form, fields: [{ ...field, bundle_max_quantities: { [id]: 0 } }, form.fields[1]] }), /purchase limits/);
});
test('cart view is display-only and requires one source cart', () => {
  const view = { id: 'view', type: 'sales_cart_view' };
  assert.equal(cartConfigurationError({ ...form, fields: [...form.fields, view] }), null);
  assert.match(cartConfigurationError({ fields: [view] }), /Add a Cart/);
  assert.match(cartConfigurationError({ ...form, fields: [...form.fields, { ...view, required: true }] }), /display element/);
});

test('presentation configuration accepts old defaults and validates explicit values', () => {
  const check = patch => cartConfigurationError({ ...form, fields: [{ ...field, ...patch }, form.fields[1]] });
  assert.equal(check({ bundle_label: 'Package', bundle_category_label: 'Exhibitor level', bundle_required: false }), null);
  assert.match(check({ bundle_required: 'true' }), /on or off/);
  assert.match(check({ bundle_required: true }), /at least one bundle/);
  assert.match(check({ bundle_label: 'x'.repeat(121) }), /120/);
  for (const products_heading of ['', 'Select other options', 'x'.repeat(120)]) {
    assert.equal(check(JSON.parse(JSON.stringify({ products_heading }))), null);
  }
  for (const products_heading of [null, 123, {}, 'x'.repeat(121)]) {
    assert.match(check({ products_heading }), /120/);
  }
  for (const bundle_display of [undefined, 'cards', 'dropdown']) {
    for (const show_bundle_category of [undefined, true, false]) {
      const restored = JSON.parse(JSON.stringify({ ...form, fields: [{ ...field, bundle_display, show_bundle_category }, form.fields[1]] }));
      assert.equal(cartConfigurationError(restored), null);
    }
  }
  for (const bundle_display of ['', null, 'grid', true]) assert.match(cartConfigurationError({ ...form, fields: [{ ...field, bundle_display }, form.fields[1]] }), /Bundle display/);
  for (const show_bundle_category of [null, 'true', 1]) assert.match(cartConfigurationError({ ...form, fields: [{ ...field, show_bundle_category }, form.fields[1]] }), /boolean/);
});

test('cart configuration restricts placement, supported forms and payment ownership', () => {
  assert.equal(cartConfigurationError(form), null);
  for (const type of ['survey', 'other']) assert.match(cartConfigurationError({ ...form, form_type: type }), /standard/);
  assert.match(cartConfigurationError({ fields: [{ type: 'repeatable_rows', children: [field] }] }), /nested/);
  assert.match(cartConfigurationError({ ...form, fields: [...form.fields, field] }), /one Cart/);
  assert.match(cartConfigurationError({ ...form, fields: [field] }), /Payment/);
  assert.match(cartConfigurationError({ ...form, fields: [...form.fields, { type: 'membership_payment' }] }), /membership/);
  assert.match(cartConfigurationError({ ...form, fields: [field, { ...form.fields[1], allow_monthly_payments: true }] }), /one-off/);
  assert.match(cartConfigurationError({ ...form, fields: [{ ...field, allowed_bundle_ids: [id] }, form.fields[1]] }), /tax/);
});
test('cart normalization merges duplicate lines, bounds quantities and strips browser prices', () => {
  assert.deepEqual(normalizeCartAnswer({ version: 1, lines: [
    { id, kind: 'product', quantity: 1, unitPriceMinor: 1, name: 'Forged' },
    { id, kind: 'product', quantity: 2 },
  ] }), answer(3));
  for (const quantity of [0, -1, 1.5, '1', NaN, Infinity, 1001, null]) assert.throws(() => normalizeCartAnswer(answer(quantity)));
  assert.throws(() => normalizeCartAnswer({ version: 1, lines: [answer(1000).lines[0], answer(1).lines[0]] }));
  assert.throws(() => normalizeCartAnswer({ ...answer(1), version: 2 }));
  assert.throws(() => normalizeCartAnswer({ version: 1, lines: Array(101).fill(answer(1).lines[0]) }));
});
test('cart prices use catalogue net prices and line-rounded tax exactly once', () => {
  const receipt = priceCartLines(answer(3), [item], 'GBP');
  assert.equal(receipt.netMinor, 303);
  assert.equal(receipt.taxMinor, 61);
  assert.equal(receipt.grossMinor, 364);
  assert.match(formatCartReceipt(receipt), /3 × Original name — Accepted description/);
  assert.match(formatCartReceipt(receipt), /Total: GBP 3.64/);
  assert.throws(() => priceCartLines(answer(4), [item], 'GBP'), /stock/);
  assert.throws(() => priceCartLines(answer(1), [item], 'EUR'), /currency/);
  assert.throws(() => priceCartLines(answer(1), [{ ...item, taxTreatment: 'exempt' }], 'GBP'), /tax/);
  assert.throws(() => priceCartLines(answer(1000), [{ ...item, remaining: null, unitPriceMinor: Number.MAX_SAFE_INTEGER }], 'GBP'));
  assert.equal(priceCartLines(answer(1000), [{ ...item, remaining: null }], 'GBP').lines[0].quantity, 1000);
});

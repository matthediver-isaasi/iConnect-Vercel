import test from 'node:test';
import assert from 'node:assert/strict';
import { cartOptions, resolveFormCart } from './formCart.js';

const id = '20000000-0000-4000-8000-000000000001';
const category = '20000000-0000-4000-8000-000000000002';
const base = { id, tenant_id: 'tenant', name: 'Pack', currency: 'GBP', is_active: true, selling_price_minor: 100, category_id: category };
const field = { id: 'cart', type: 'sales_cart', cart_version: 1, allowed_product_ids: [], allowed_bundle_ids: [id],
  bundle_tax: { [id]: { treatment: 'zero_rated', rateBps: 0 } } };
test('required bundles reject empty and product-only answers before checkout; hidden carts remain exempt', async () => {
  const db = { rpc: async () => ({ data: 1 }) };
  const form = { fields: [{ ...field, bundle_required: true }, { id: 'pay', type: 'payment', price_field_id: 'cart' }] };
  for (const lines of [[], [{ id, kind: 'product', quantity: 1 }]]) {
    await assert.rejects(resolveFormCart(db, form, { cart: { version: 1, lines } }, { hiddenFieldIds: new Set() }), /Add at least one bundle/);
  }
  assert.equal(await resolveFormCart(db, form, {}, { hiddenFieldIds: new Set(['cart']) }), null);
});
test('server rejects combined bundle quantities above the saved limit', async () => {
  const db = { rpc: async () => ({ data: 1 }) };
  const form = { fields: [{ ...field, bundle_max_quantities: { [id]: 1 } }, { id: 'pay', type: 'payment', price_field_id: 'cart' }] };
  await assert.rejects(resolveFormCart(db, form, { cart: { version: 1, lines: [
    { id, kind: 'bundle', quantity: 1 }, { id, kind: 'bundle', quantity: 1 },
  ] } }, { hiddenFieldIds: new Set() }), /maximum of 1/);
});
for (const enabled of [false, true]) test(`cart bundle category metadata is tenant scoped and optional: ${enabled}`, async () => {
  const reads = [];
  const db = {
    rpc: async () => ({ data: 1 }),
    from(table) {
      const filters = [];
      return { select(columns) { reads.push({ table, columns, filters }); return this; },
        eq(k, v) { filters.push([k, v]); return this; }, in(k, v) { filters.push([k, v]); return this; },
        then(resolve) {
          const data = table === 'sales_catalogue_bundle' ? [base]
            : table === 'sales_catalogue_category' ? [{ id: category, name: 'Bundle category' }]
            : table === 'form_bundle_stock' ? [{ bundle_id: id, remaining: 0 }] : [];
          resolve({ data });
        } };
    },
  };
  const form = { tenant_id: 'tenant', fields: [{ ...field, show_bundle_category: enabled }, { id: 'pay', type: 'payment', price_field_id: 'cart' }] };
  const [option] = await cartOptions(db, form, 'cart');
  assert.equal(option.available, false);
  assert.equal(option.categoryName, enabled ? 'Bundle category' : undefined);
  assert.equal(reads.some(read => read.table === 'sales_catalogue_category'), enabled);
  for (const read of reads) assert.ok(read.filters.some(([key, value]) => key === 'tenant_id' && value === 'tenant'));
  if (enabled) {
    const read = reads.find(read => read.table === 'sales_catalogue_category');
    assert.equal(read.columns, 'id,name');
    assert.deepEqual(read.filters.find(([key]) => key === 'id')[1], [category]);
    db.from = () => ({ select() { return this; }, eq() { return this; }, in() { return this; }, then(resolve) { resolve({ error: new Error('load failed') }); } });
    await assert.rejects(cartOptions(db, form, 'cart'), /load failed/);
  }
});

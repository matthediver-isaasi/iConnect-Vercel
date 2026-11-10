import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleConfigurationError } from '../../shared/formBundles.js';
import { bundleOptions, bundlePayableAmount, resolveFormBundle, validateBundleConfiguration } from './formBundles.js';
import { updateBundleStock } from './salesCatalogue.js';
const id = '20000000-0000-4000-8000-000000000001';
const form = { tenant_id: 'tenant', fields: [
  { id: 'bundle', type: 'sales_bundle', required: true, allowed_bundle_ids: [id] },
  { id: 'payment', type: 'payment', price_field_id: 'bundle', payment_currency: 'GBP' },
] };
const row = { id, name: 'Saved name', selling_price_minor: 12345, currency: 'GBP', is_active: true };
function dbFor(rows = [row], remaining = null) {
  const calls = [];
  return { calls, rpc: async () => ({ data: 1 }), from(table) {
    const result = table === 'sales_catalogue_bundle' ? rows : [{ bundle_id: id, remaining }];
    return { select() { return this; }, eq(k, v) { calls.push([table,k,v]); return this; },
      in() { return this; }, then(resolve) { resolve({ data: result }); } };
  } };
}
test('configuration rejects nested, survey, multiple and ambiguous currency bundles', async () => {
  assert.equal(bundleConfigurationError(form), null);
  assert.match(bundleConfigurationError({ ...form, form_type: 'survey' }), /standard/);
  assert.match(bundleConfigurationError({ ...form, fields: [form.fields[0], form.fields[0]] }), /one/);
  assert.match(bundleConfigurationError({ fields: [{ type: 'repeatable_rows', children: [form.fields[0]] }] }), /nested/);
  assert.match(bundleConfigurationError({ ...form, visibility_rules: [{ actions: [{ action_type: 'membership_structure' }] }] }), /membership/);
  await assert.rejects(validateBundleConfiguration(dbFor([{ ...row, currency: 'EUR' }]), form), /currency/);
  await assert.rejects(validateBundleConfiguration(dbFor([]), form), /tenant/);
});
test('stock policy is strictly boolean, defaults on, and does not bypass resolution', async () => {
  for (const policy of [undefined, true, false]) {
    const configured = { ...form, fields: [{ ...form.fields[0], reduce_bundle_stock_on_submission: policy }, form.fields[1]] };
    assert.equal(bundleConfigurationError(configured), null);
    const values = { bundle: id, other: 'retained' };
    assert.equal(await bundlePayableAmount(dbFor(), configured, values, configured.fields[1]), 123.45);
    assert.equal(values.__bundle_labels.bundle, 'Saved name');
    await assert.rejects(resolveFormBundle(dbFor([row], 0), configured, values), /no longer available/);
    assert.equal(values.other, 'retained');
  }
  for (const policy of [null, 'false', 0, {}, []]) {
    assert.match(bundleConfigurationError({ ...form, fields: [{ ...form.fields[0], reduce_bundle_stock_on_submission: policy }] }), /on or off/);
  }
});
test('category filter exposes only tenant-scoped category names and preserves price and stock authority', async () => {
  const calls = [];
  const db = { from(table) {
    const rows = table === 'sales_catalogue_bundle' ? [{ ...row, category_id: 'category-a' }]
      : table === 'sales_catalogue_category' ? [{ id: 'category-a', name: 'Bronze Exhibitor' }]
        : [{ bundle_id: id, remaining: 0 }];
    return { select() { return this; }, eq(k,v) { calls.push([table,k,v]); return this; },
      in(k,v) { calls.push([table,k,v]); return this; }, then(resolve) { resolve({ data: rows }); } };
  } };
  const filtered = { ...form, fields: [{ ...form.fields[0], show_bundle_category: true }, form.fields[1]] };
  const [option] = await bundleOptions(db, filtered, 'bundle');
  assert.equal(option.categoryName, 'Bronze Exhibitor');
  assert.equal(option.categoryId, 'category-a');
  assert.equal(option.amountMinor, row.selling_price_minor);
  assert.equal(option.available, false);
  assert.ok(calls.some(([table,k,v]) => table === 'sales_catalogue_category' && k === 'tenant_id' && v === form.tenant_id));
  assert.equal((await bundleOptions(db, form, 'bundle'))[0].categoryName, undefined);
  assert.match(bundleConfigurationError({ ...form, fields: [{ ...form.fields[0], show_bundle_category: 'true' }] }), /on or off/);
});
test('UUID is never parsed as a price; browser labels and prices have no authority', async () => {
  const db = dbFor();
  const values = { bundle: id, __bundle_labels: { bundle: 'Forged' }, amount: 1 };
  assert.equal(await bundlePayableAmount(db, form, values, form.fields[1]), 123.45);
  assert.equal(values.__bundle_labels.bundle, 'Saved name');
  assert.ok(db.calls.every(([, key, value]) => key !== 'tenant_id' || value === form.tenant_id));
  await assert.rejects(resolveFormBundle(db, form, { bundle: { id, price: 1 } }), /allowed/);
  await assert.rejects(resolveFormBundle(dbFor([]), form, { bundle: id }), /no longer available/);
});
test('hidden answers remain raw for other rules but cannot allocate or price', async () => {
  const values = { bundle: id, other: 'retain', __bundle_hidden: 'forged' };
  assert.equal(await resolveFormBundle(dbFor(), form, values, { hiddenFieldIds: new Set(['bundle']) }), null);
  assert.equal(values.bundle, id);
  assert.equal(values.other, 'retain');
  assert.equal(values.__bundle_hidden, 'bundle');
  await resolveFormBundle(dbFor(), form, values, { hiddenFieldIds: new Set() });
  assert.equal(values.__bundle_hidden, undefined);
});
test('sold out remains listed disabled; failures are not empty availability', async () => {
  const db = dbFor([row], 0);
  assert.equal((await bundleOptions(db, form, 'bundle'))[0].available, false);
  await assert.rejects(resolveFormBundle(db, form, { bundle: id }), e => e.status === 409);
  assert.equal((await resolveFormBundle(db, form, { bundle: id }, { checkStock: false })).id, id);
  assert.deepEqual(await bundleOptions(dbFor([{ ...row, is_active: false }]), form, 'bundle'), []);
  const broken = { from: () => ({ select() { return this; }, eq() { return this; }, in: async () => ({ error: new Error('outage') }) }) };
  await assert.rejects(bundleOptions(broken, form, 'bundle'), /outage/);
});
test('stock edits reject coercion and forward the original editor version', async () => {
  for (const remaining of [-1,1.2,'2',false,undefined]) {
    await assert.rejects(updateBundleStock({}, 'tenant', { actorId: 'admin' }, id,
      { remaining, expectedVersion: 2 }), /whole number/);
  }
  let args;
  const db = { rpc: async (_, value) => {
    args = value; return { data: { remaining: 4, reserved: 1, version: 9 } };
  } };
  assert.deepEqual(await updateBundleStock(db, 'tenant', { actorId: 'admin' }, id,
    { remaining: 4, expectedVersion: 8 }), { remaining: 4, reserved: 1, version: 9 });
  assert.equal(args.p_expected_version, 8);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { formBundleStockOptionReady } from './formBundleStockReadiness.js';
import { validateBundleConfiguration, resolveFormBundle, recoverBundlePaymentAttempt } from './formBundles.js';
import { createSalesCatalogueHandler } from '../sales/catalogue/[...path].js';

const bundle = '20000000-0000-4000-8000-000000000001';
const form = { tenant_id: 'tenant', fields: [{
  id: 'bundle', type: 'sales_bundle', allowed_bundle_ids: [bundle], reduce_bundle_stock_on_submission: false,
}] };
const missing = { rpc: async () => ({ error: { code: 'PGRST202' } }),
  from() { throw new Error('Unexpected table read on unmigrated schema'); } };

test('readiness distinguishes old schema from outages and only enables version one', async () => {
  for (const code of ['PGRST202', '42883']) {
    assert.equal(await formBundleStockOptionReady({ rpc: async () => ({ error: { code } }) }), false);
  }
  for (const data of [null, false, 0, 2, '1']) {
    assert.equal(await formBundleStockOptionReady({ rpc: async () => ({ data }) }), false);
  }
  assert.equal(await formBundleStockOptionReady({ rpc: async () => ({ data: 1 }) }), true);
  await assert.rejects(formBundleStockOptionReady({ rpc: async () => ({ error: new Error('outage') }) }), /outage/);
});
test('unmigrated schema rejects disabled saves and new acceptance before inventory access', async () => {
  await assert.rejects(validateBundleConfiguration(missing, form), e => e.code === 'BUNDLE_STOCK_OPTION_NOT_READY');
  await assert.rejects(resolveFormBundle(missing, form, { bundle }, { hiddenFieldIds: new Set() }),
    e => e.code === 'BUNDLE_STOCK_OPTION_NOT_READY');
});
test('legacy retry with no allocation never reads nonexistent selection receipts', async () => {
  const db = { ...missing, from(table) {
    assert.equal(table, 'form_bundle_allocation');
    return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null }) };
  } };
  assert.equal(await recoverBundlePaymentAttempt(db, { id: 's', tenant_id: 'tenant' }, {}, 'stripe'), null);
});
test('catalogue publishes migration readiness to the builder without changing its items', async () => {
  for (const ready of [false, true]) {
    const db = { rpc: async () => ready ? { data: 1 } : { error: { code: 'PGRST202' } },
      from() { return { select() { return this; }, eq() { return this; }, order() { return this; },
        then(resolve) { resolve({ data: [] }); } }; } };
    const handler = createSalesCatalogueHandler({ db,
      getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant', tenantUserId: 'admin' }) });
    const res = { status(c) { this.code = c; return this; }, json(data) { this.body = data; return this; } };
    await handler({ method: 'GET', query: { path: ['bundles'] } }, res);
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { items: [], stockOptionReady: ready });
  }
});

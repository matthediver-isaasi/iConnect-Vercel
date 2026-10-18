import test from 'node:test';
import assert from 'node:assert/strict';
import { createSalesCatalogueHandler } from '../sales/catalogue/[...path].js';
import { generateCatalogueCode } from './salesCatalogue.js';

const productId = '00000000-0000-4000-8000-000000000001';
const product = {
  name: 'Product (copy)', currency: 'GBP', standardPriceMinor: 12345,
  minimumPriceMinor: 11111, costMinor: 1123, taxCode: { provider: 'xero', id: 'OUTPUT' },
  createTaskOnAcceptance: true, capacityMetadata: { custom: 7 },
};
const bundle = {
  name: 'Bundle (copy)', currency: 'GBP', sellingPriceMinor: 999, minimumPriceMinor: 500,
  presentationMode: 'itemised', items: [{ productId, quantity: 3 }],
};

function fixture(options = {}) {
  const calls = [], reads = [], settingsReads = [];
  let serial = 0;
  const db = {
    from(table) {
      reads.push(table);
      const data = table === 'system_settings' ? { setting_value: JSON.stringify({
        rates: [{ taxType: 'OUTPUT', name: 'Current VAT', effectiveRate: 20, status: 'ACTIVE', canApplyToRevenue: true }],
      }) } : table === 'sales_catalogue_product'
        ? [{ id: productId, is_active: options.active !== false }]
        : table === 'sales_catalogue_category' ? options.category || null : null;
      return {
        select() { return this; }, eq() { return this; }, in() { return this; },
        maybeSingle: async () => ({ data, error: null }),
        then(resolve) { resolve({ data, error: null }); },
      };
    },
    async rpc(name, args) {
      calls.push({ name, args: structuredClone(args) });
      const error = options.errors?.[calls.length - 1];
      return error ? { error } : { data: {
        ...args.p_record, id: 'new-id', is_active: true, archived_at: null,
        items: args.p_items?.map((item, displayOrder) => ({ ...item, displayOrder })),
      } };
    },
  };
  const handler = createSalesCatalogueHandler({
    db,
    getTenantContext: async () => options.context || {
      isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'admin-a',
    },
    hasFeatureAccess: async () => false,
    getActiveAccountingProvider: async () => 'xero',
    getSalesSettings: async (_, tenantId) => {
      settingsReads.push(tenantId);
      if (options.settingsError) throw new Error('private settings failure');
      return { showInternalCode: options.showInternalCode ?? false, showSku: options.showSku ?? true };
    },
    generateCatalogueCode: type => `${type === 'bundles' ? 'BND' : 'PRD'}_GENERATED_${++serial}`,
  });
  return {
    calls, reads, settingsReads,
    async post(type, body) {
      const res = { status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; }, setHeader() {} };
      await handler({ method: 'POST', query: { path: [type] }, body }, res);
      return res;
    },
  };
}

test('generated codes satisfy storage format and have fresh random identities', () => {
  const codes = Array.from({ length: 100 }, () => generateCatalogueCode('products'));
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.every(code => /^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(code)));
  assert.match(generateCatalogueCode('bundles'), /^BND_/);
});

test('hidden-code product and ordered bundle creates use one tenant/actor-scoped atomic RPC', async () => {
  for (const showSku of [true, false]) {
    for (const [type, body] of [['products', product], ['bundles', bundle]]) {
      const f = fixture({ showSku });
      const source = structuredClone(body);
      const res = await f.post(type, body);
      assert.equal(res.statusCode, 201);
      assert.deepEqual(body, source);
      assert.deepEqual(f.settingsReads, ['tenant-a']);
      assert.equal(f.calls.length, 1);
      const { name, args } = f.calls[0];
      assert.equal(name, 'create_sales_catalogue_record');
      assert.equal(args.p_tenant_id, 'tenant-a');
      assert.equal(args.p_actor_id, 'admin-a');
      assert.equal(args.p_actor_type, 'tenant_user');
      assert.equal(args.p_type, type);
      assert.match(args.p_record.code, /_GENERATED_1$/);
      if (type === 'products') {
        assert.equal(args.p_record.sku, null);
        assert.equal(args.p_record.tax_rate_bps, 2000);
        assert.equal(args.p_record.tax_code.name, 'Current VAT');
        assert.equal(args.p_record.standard_price_minor, 12345);
        assert.equal(args.p_record.minimum_price_minor, 11111);
        assert.equal(args.p_record.cost_minor, 1123);
        assert.equal(args.p_record.create_task_on_acceptance, true);
        assert.deepEqual(args.p_record.capacity_metadata, { custom: 7 });
      } else {
        assert.deepEqual(args.p_items, bundle.items);
        assert.equal(res.body.items[0].quantity, 3);
        assert.equal(res.body.sellingPriceMinor, 999);
      }
    }
  }
});

test('visible-code validation is unchanged in both SKU modes; categories never generate', async () => {
  for (const showSku of [false, true]) {
    for (const type of ['products', 'bundles']) {
      const body = type === 'products' ? product : bundle;
      const f = fixture({ showInternalCode: true, showSku });
      assert.equal((await f.post(type, body)).statusCode, 400);
      assert.equal(f.calls.length, 0);
      const valid = fixture({ showInternalCode: true, showSku });
      assert.equal((await valid.post(type, { ...body, code: 'MANUAL' })).statusCode, 201);
      assert.equal(valid.settingsReads.length, 0);
    }
  }
  const f = fixture();
  assert.equal((await f.post('categories', { name: 'Category' })).statusCode, 400);
  assert.equal(f.settingsReads.length, 0);
});

test('effective body is validated after generation, and hidden codes do not override supplied invalid values', async () => {
  for (const body of [{ ...bundle, sellingPriceMinor: -1 }, { ...bundle, code: 'bad code' },
    { ...bundle, createdBy: 'forged' }, null, []]) {
    const f = fixture();
    assert.equal((await f.post('bundles', body)).statusCode, 400);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ settingsError: true });
  const res = await f.post('bundles', bundle);
  assert.equal(res.statusCode, 500);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(res.body.error, /private/);
});

test('only generated entity-code collisions retry; manual, SKU, component and audit failures do not', async () => {
  const collision = { code: '23505', message: 'duplicate key violates unique constraint "sales_catalogue_bundle_code_unique"' };
  const f = fixture({ errors: [collision] });
  assert.equal((await f.post('bundles', bundle)).statusCode, 201);
  assert.deepEqual(f.calls.map(call => call.args.p_record.code), ['BND_GENERATED_1', 'BND_GENERATED_2']);
  const exhausted = fixture({ errors: [collision, collision, collision] });
  assert.equal((await exhausted.post('bundles', bundle)).statusCode, 409);
  assert.equal(exhausted.calls.length, 3);
  for (const error of [
    { code: '23505', constraint: 'sales_catalogue_product_sku_unique' },
    { code: '23505', constraint: 'sales_catalogue_bundle_item_unique' },
    { code: '23505', constraint: 'sales_audit_event_unique' },
    { code: '23503', message: 'component reference' },
    { code: 'XX000', message: 'audit failure' },
  ]) {
    const failed = fixture({ errors: [error] });
    assert.ok((await failed.post('bundles', bundle)).statusCode >= 400);
    assert.equal(failed.calls.length, 1);
  }
  const manual = fixture({ errors: [collision] });
  assert.equal((await manual.post('bundles', { ...bundle, code: 'MANUAL' })).statusCode, 409);
  assert.equal(manual.calls.length, 1);
});

test('current tax identity and unavailable category/event/component references fail before persistence', async () => {
  for (const body of [
    { ...product, taxCode: { provider: 'xero', id: 'DELETED' } },
    { ...product, taxCode: { provider: 'quickbooks', id: 'OUTPUT' } },
    { ...product, taxCode: null },
    { ...product, categoryId: productId },
    { ...product, eventReference: { kind: 'simple', eventId: productId, ticketTypeId: 'missing' } },
  ]) {
    const f = fixture();
    assert.ok([400, 409].includes((await f.post('products', body)).statusCode));
    assert.equal(f.calls.length, 0);
  }
  const inactive = fixture({ active: false });
  assert.equal((await inactive.post('bundles', bundle)).statusCode, 400);
  assert.equal(inactive.calls.length, 0);
});

test('unauthenticated, tenant-mismatched and unauthorized portal callers cannot discover settings or create', async () => {
  for (const context of [
    { isAuthenticated: false },
    { isAuthenticated: true, tenantMismatch: true },
    { isAuthenticated: true, tenantId: 'tenant-a', memberId: 'member', roleId: 'viewer' },
  ]) {
    const f = fixture({ context });
    assert.ok([401, 403, 409].includes((await f.post('bundles', bundle)).statusCode));
    assert.equal(f.calls.length, 0);
    assert.equal(f.settingsReads.length, 0);
    assert.equal(f.reads.length, 0);
  }
});

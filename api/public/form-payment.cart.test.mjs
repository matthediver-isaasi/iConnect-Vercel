import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './form-payment.js';
import { cartOptions, resolveFormCart, formCartReady } from '../_lib/formCart.js';
import { formBundlesHandler } from './form-bundles.js';
import { cleanupFormBundleHolds } from '../_lib/formBundleCleanup.js';

const product = '20000000-0000-4000-8000-000000000001';
const bundle = '20000000-0000-4000-8000-000000000002';
const cart = { id: 'cart', type: 'sales_cart', cart_version: 1, required: true,
  allowed_product_ids: [product], allowed_bundle_ids: [bundle], bundle_tax: { [bundle]: { treatment: 'zero_rated', rateBps: 0 } } };
const form = { id: 'form', tenant_id: 'tenant', is_active: true, form_type: 'standard',
  fields: [cart, { id: 'name', type: 'text', required: true }, {
    id: 'payment', type: 'payment', price_field_id: 'cart', payment_currency: 'GBP', payment_providers: ['stripe', 'gocardless'],
  }], visibility_rules: [], entity_pipelines: {} };
const answer = { version: 1, lines: [{ kind: 'bundle', id: bundle, quantity: 1 }, { kind: 'product', id: product, quantity: 2 }] };
const values = { cart: answer, name: 'Required answer' };
const res = () => ({ statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; } });

function fixture({ ready = true, insertError = null, existing = null } = {}) {
  const state = { row: existing, receipt: existing?.submission_data?.__cart_receipt ? {
    field_id: 'cart', answer, terms: existing.submission_data.__cart_receipt, state: 'held',
  } : null, inserts: 0, updates: 0, providerCreates: 0, scopes: [], noCatalogue: false,
  products: [{ id: product, name: 'Product', description: 'Original product', standard_price_minor: 100,
    tax_treatment: 'standard', tax_rate_bps: 2000, currency: 'GBP', is_active: true }],
  bundles: [{ id: bundle, name: 'Bundle', description: 'Original bundle', selling_price_minor: 500, currency: 'GBP', is_active: true }] };
  const db = { rpc: async name => name === 'form_cart_version'
    ? ready ? { data: 1 } : { error: { code: 'PGRST202' } } : { data: null },
    from(table) {
      if (state.noCatalogue) assert.ok(!table.startsWith('sales_catalogue'), 'retry must not read current catalogue');
      let one = false, op = null, patch = null;
      const query = {
        select() { return this; }, eq(key, value) { state.scopes.push([table, key, value]); return this; },
        in() { return this; }, is() { return this; }, order() { return this; }, limit() { return this; },
        maybeSingle() { one = true; return this; }, single() { one = true; return this; },
        insert(data) { op = 'insert'; patch = data; return this; },
        update(data) { op = 'update'; patch = data; return this; },
        then(resolve) {
          if (table === 'form_submission' && op === 'insert') {
            state.inserts++;
            if (insertError) return resolve({ error: insertError });
            state.row = { id: 'submission', ...patch };
            state.receipt = { field_id: 'cart', answer, terms: patch.submission_data.__cart_receipt, state: 'held' };
          }
          if (table === 'form_submission' && op === 'update') {
            state.updates++; state.row = { ...state.row, ...patch };
          }
          const entries = {
            form: form, form_submission: state.row, form_cart_receipt: state.receipt,
            sales_catalogue_product: state.products, sales_catalogue_bundle: state.bundles,
            sales_catalogue_bundle_item: [{ bundle_id: bundle, product_id: product }],
            form_product_stock: [{ product_id: product, remaining: 10 }],
            form_bundle_stock: [{ bundle_id: bundle, remaining: 10 }],
          };
          const data = Object.hasOwn(entries, table) ? entries[table] : one ? null : [];
          resolve({ data });
        },
      };
      return query;
    } };
  const dependencies = { supabase: db, tenantData: { id: 'tenant' },
    getSessionMember: async () => null, getTenantContext: async () => ({ isAuthenticated: false }),
    getStripeCredentials: async () => ({ secret_key: 'sk_test_fixture', publishable_key: 'pk_test_fixture' }),
    stripe: { paymentIntents: { create: async (params, options) => {
      state.providerCreates++;
      assert.equal(params.amount, 740);
      assert.equal(options.idempotencyKey, 'form-bundle:submission');
      return { id: 'pi_cart', client_secret: 'fixture_secret' };
    } } },
    inspectPriorFormStripeIntent: async args => {
      assert.equal(args.amountMinor, 740);
      return { kind: 'reusable', intent: { id: 'pi_cart', client_secret: 'fixture_secret' }, publishableKey: 'pk_test_fixture' };
    },
  };
  const request = async (action = 'create', overrides = {}) => {
    const response = res();
    await handler({ method: 'POST', headers: {}, body: { action, form_id: form.id, provider: 'stripe',
      idempotency_key: 'cart-attempt', submission_data: structuredClone(values), ...overrides } }, response, dependencies);
    return response;
  };
  return { state, db, dependencies, request };
}

test('mixed cart quote and checkout ignore browser prices, then recover immutable retry', async () => {
  const { request, state } = fixture();
  const quote = await request('quote');
  assert.equal(quote.statusCode, 200, JSON.stringify(quote.body));
  assert.equal(quote.body.amount, 7.4);
  assert.equal(quote.body.cart.taxMinor, 40);
  const create = await request();
  assert.equal(create.statusCode, 200, JSON.stringify(create.body));
  assert.equal(state.providerCreates, 1);
  state.noCatalogue = true;
  const retry = await request();
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.amount, 7.4);
  assert.equal(state.providerCreates, 1);
  assert.equal(state.inserts, 1);
  const edited = await request('create', { submission_data: { ...values, cart: { version: 1, lines: [] } } });
  assert.equal(edited.statusCode, 409);
  assert.equal(edited.body.code, 'IDEMPOTENCY_KEY_REUSED');
});
test('readiness, required fields and reservation conflicts fail before provider creation', async () => {
  for (const scenario of ['not-ready', 'required', 'stock']) {
    const f = fixture({ ready: scenario !== 'not-ready',
      insertError: scenario === 'stock' ? { code: 'P0001', message: 'Cart item has insufficient stock' } : null });
    const response = await f.request('create', scenario === 'required' ? { submission_data: { cart: answer } } : {});
    assert.equal(response.statusCode, scenario === 'not-ready' ? 503 : scenario === 'required' ? 400 : 409, JSON.stringify(response.body));
    assert.equal(f.state.providerCreates, 0);
  }
});
test('provider creation ambiguity retains one accepted attempt; retry uses original idempotency key', async () => {
  const f = fixture();
  const create = f.dependencies.stripe.paymentIntents.create;
  f.dependencies.stripe.paymentIntents.create = async () => { throw new Error('fixture provider timeout'); };
  const response = await f.request();
  assert.equal(response.statusCode, 500);
  assert.equal(f.state.receipt.state, 'held');
  f.dependencies.stripe.paymentIntents.create = create;
  const retry = await f.request();
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  assert.equal(f.state.inserts, 1);
});
test('cart options enforce access and tenant scope without exposing internal catalogue data', async () => {
  const f = fixture();
  const response = res();
  await formBundlesHandler({ method: 'GET', query: { form_id: 'form', field_id: 'cart' } }, response, {
    db: f.db, resolveTenant: async () => ({ id: 'tenant' }),
    resolveAccess: async () => ({ allowed: false, reason: 'authentication_required' }),
  });
  assert.notEqual(response.statusCode, 200);
  assert.equal(f.state.scopes.some(([table]) => table === 'sales_catalogue_product'), false);
  const options = await cartOptions(f.db, form, 'cart');
  assert.equal(options.length, 2);
  assert.equal(options[0].cost_minor, undefined);
  assert.ok(f.state.scopes.filter(([table]) => table.startsWith('sales_catalogue')).every(([, key, value]) => key === 'tenant_id' && value === 'tenant'));
  f.state.products[0].space_requirement_id = 'unsupported';
  assert.equal((await cartOptions(f.db, form, 'cart')).length, 0, 'both ordinary item and its containing bundle excluded');
});
test('hidden carts cannot allocate or price retained answers; outages are not unsupported schema', async () => {
  const f = fixture();
  const raw = { ...structuredClone(values), __cart_receipt: { grossMinor: 1 } };
  assert.equal(await resolveFormCart(f.db, form, raw, { hiddenFieldIds: new Set(['cart']) }), null);
  assert.deepEqual(raw.cart, answer);
  assert.equal(raw.__cart_hidden, 'cart');
  assert.equal(raw.__cart_receipt, undefined);
  await assert.rejects(formCartReady({ rpc: async () => ({ error: { code: '08006' } }) }), error => error.code === '08006');
});
test('cart cleanup retains ambiguous outcomes and releases only verified terminal cancellation', async () => {
  for (const status of ['processing', 'succeeded', 'canceled']) {
    const calls = [];
    const row = { id: 'submission', tenant_id: 'tenant', form_id: 'form',
      payment_provider: 'stripe', payment_reference: 'pi_cart', payment_status: 'pending' };
    const db = { rpc: async (name, args) => { calls.push([name, args]); return { data: name === 'form_cart_version' ? 1 : {} }; },
      from: table => {
        const q = { select() { return this; }, eq() { return this; }, lte() { return this; },
          order() { return this; }, limit() { return this; }, single() { return this; },
          then(resolve) { resolve({ data: table === 'form_cart_receipt' ? [{ tenant_id: 'tenant', submission_id: 'submission' }] : row }); } };
        return q;
      } };
    await cleanupFormBundleHolds(db, { cart: true, retrieveStripe: async () => ({
      paymentIntent: { id: 'pi_cart', status, metadata: { tenant_id: 'tenant', form_id: 'form', form_submission_id: 'submission' } },
    }) });
    assert.equal(calls.some(([name]) => name === 'finalize_form_cart'), status === 'canceled');
    assert.equal(calls.some(([name]) => name === 'defer_form_cart_check'), status !== 'canceled');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './form-payment.js';
const bundleId = '20000000-0000-4000-8000-000000000001';
const form = {
  id: 'form', tenant_id: 'tenant', is_active: true, form_type: 'application',
  fields: [
    { id: 'bundle', type: 'sales_bundle', allowed_bundle_ids: [bundleId] },
    { id: 'payment', type: 'payment', price_field_id: 'bundle', payment_currency: 'GBP', payment_providers: ['stripe'] },
  ], visibility_rules: [], entity_pipelines: {},
};
const submission = {
  id: 'submission', form_id: form.id, tenant_id: form.tenant_id, idempotency_key: 'pay:original',
  submission_data: { bundle: bundleId, name: 'Original answers', __bundle_labels: { bundle: 'Original name' } },
  payment_provider: 'stripe', payment_status: 'pending', payment_reference: 'pi_original',
  payment_amount: 125, payment_currency: 'GBP', payment_meta: { price_field_id: 'bundle', stripe_feature: 'forms' },
};
for (const change of ['price changed', 'bundle archived']) {
 for (const allocates of [true, false]) {
  test(`same-key retry recovers original payable intent after ${change}, allocates=${allocates}`, async () => {
    let recovered = 0;
    const catalogue = { selling_price_minor: change === 'price changed' ? 99000 : 12500,
      is_active: change !== 'bundle archived' };
    const allocation = { tenant_id: 'tenant', submission_id: 'submission',
      field_id: 'bundle', bundle_id: bundleId, state: 'held', amount_minor: 12500, currency: 'GBP' };
    const db = { rpc: async () => ({ data: 1 }), from(table) {
      assert.notEqual(table, 'sales_catalogue_bundle', `must not consult changed catalogue: ${JSON.stringify(catalogue)}`);
      assert.ok(['form','form_submission','form_bundle_allocation','form_bundle_selection'].includes(table), `unexpected ${table}`);
      return {
        select() { return this; }, eq() { return this; }, maybeSingle() { return this; }, single() { return this; },
        then(resolve) { resolve({ data: table === 'form'
          ? { ...form, fields: [{ ...form.fields[0], reduce_bundle_stock_on_submission: !allocates }, form.fields[1]] }
          : table === 'form_submission' ? submission
          : table === 'form_bundle_allocation' ? (allocates ? allocation : null) : { ...allocation, state: undefined } }); },
      };
    } };
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; } };
    await handler({ method: 'POST', headers: {}, body: {
      action: 'create', form_id: form.id, provider: 'stripe', idempotency_key: 'original',
      submission_data: { bundle: bundleId, name: 'Original answers' },
    } }, res, {
      supabase: db, tenantData: { id: 'tenant' }, getSessionMember: async () => null,
      getTenantContext: async () => ({ isAuthenticated: false }),
      getStripeCredentials: async () => ({ secret_key: 'sk_test_fixture', publishable_key: 'pk_test_fixture' }),
      inspectPriorFormStripeIntent: async args => {
        recovered++;
        assert.equal(args.paymentIntentId, 'pi_original');
        assert.equal(args.amountMinor, 12500);
        assert.equal(args.currency, 'GBP');
        return { kind: 'reusable', intent: { id: 'pi_original', client_secret: 'fixture_client_secret' },
          publishableKey: 'pk_test_fixture' };
      },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.submissionId, 'submission');
    assert.equal(res.body.amount, 125);
    assert.equal(res.body.currency, 'GBP');
    assert.equal(recovered, 1);
  });
 }
}

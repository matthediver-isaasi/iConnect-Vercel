import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { patchFormSubmissionPaymentMeta } from './formStripeAddressMappingProcessing.js';
import { retryPersistedStripeAddressMappings } from './formStripeAddressMappingProcessing.js';
import { capturePaymentIntentBillingAddress } from './stripeInvoiceAddress.js';
import { submissionRequiresStripeBillingAddress } from '../public/form-payment.js';
import { buildStripeAddressTargetResolution } from '../../shared/formStripeAddressMappings.js';

test('reused checkout derives address requirement from its persisted snapshot', () => {
  const persistedMapped = {
    payment_meta: {
      stripe_address_mapping_config: {
        version: 1,
        mappings: [{
          source: 'city',
          target_entity: 'organization',
          target_type: 'core',
          target_field: 'invoicing_address',
        }],
      },
    },
  };
  assert.equal(submissionRequiresStripeBillingAddress(persistedMapped), true);
  assert.equal(submissionRequiresStripeBillingAddress({
    payment_meta: {
      stripe_address_mapping_config: { version: 1, mappings: [] },
    },
  }), false);
  assert.equal(submissionRequiresStripeBillingAddress({
    payment_meta: {
      membership: { quote: { target: 'member' } },
      stripe_address_mapping_config: { version: 1, mappings: [] },
    },
  }), true);
});

test('payment metadata patches delegate to the atomic merge RPC', async () => {
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push({ name, args });
      return {
        data: {
          finalized: true,
          stripe_billing_address: args.p_patch.stripe_billing_address,
        },
        error: null,
      };
    },
  };
  const address = { line1: '1 High Street', country: 'GB' };
  const result = await patchFormSubmissionPaymentMeta({
    db,
    tenantId: '00000000-0000-0000-0000-000000000001',
    submissionId: '00000000-0000-0000-0000-000000000002',
    patch: { stripe_billing_address: address },
  });
  assert.equal(calls[0].name, 'patch_form_submission_payment_meta');
  assert.deepEqual(calls[0].args.p_patch, { stripe_billing_address: address });
  assert.equal(result.finalized, true, 'a sibling finalization key is preserved by the merge');
});

test('ordinary mapped customerless PaymentIntent persists its immutable snapshot and invokes mapping retry', async () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const submissionId = '00000000-0000-4000-8000-000000000002';
  const organizationId = '00000000-0000-4000-8000-000000000003';
  const form = {
    id: '00000000-0000-4000-8000-000000000004',
    tenant_id: tenantId,
    entity_pipelines: {
      members: [],
      organisations: [{ id: 'primary-org', isPrimary: true, mappings: [] }],
    },
    field_mappings: [],
  };
  const mappings = [{
    source: 'formatted',
    target_entity: 'organization',
    target_type: 'core',
    target_field: 'invoicing_address',
  }];
  const submission = {
    id: submissionId,
    form_id: form.id,
    tenant_id: tenantId,
    payment_provider: 'stripe',
    payment_status: 'paid',
    submitted_by_email: null,
    created_organization_id: organizationId,
    payment_meta: {
      stripe_address_mapping_config: {
        version: 1,
        mappings,
        target_resolution: buildStripeAddressTargetResolution(form, mappings),
      },
    },
  };
  let providerSnapshot = null;
  const snapshot = await capturePaymentIntentBillingAddress({
    stripe: {
      paymentMethods: {
        retrieve: async () => ({
          billing_details: {
            address: {
              line1: '1 High Street',
              line2: null,
              city: 'London',
              state: null,
              postal_code: 'SW1A 1AA',
              country: 'GB',
            },
          },
        }),
      },
      paymentIntents: {
        update: async (_id, update) => {
          providerSnapshot = update.metadata.invoice_address_snapshot;
        },
      },
      customers: {
        update: async () => { throw new Error('ordinary payment must not require a Customer'); },
      },
    },
    paymentIntent: { id: 'pi_customerless', payment_method: 'pm_1', customer: null },
    requireCustomer: false,
  });

  let mappingRpcCalls = 0;
  const db = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          if (table === 'form_submission') return { data: submission, error: null };
          if (table === 'form') return { data: form, error: null };
          if (table === 'form_stripe_address_mapping_ledger') return { data: null, error: null };
          return { data: null, error: null };
        },
        then(resolve, reject) {
          const data = table === 'form_submission_entity_creation'
            ? [{ entity_type: 'organization', entity_id: organizationId }]
            : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
    },
    async rpc(name, args) {
      if (name === 'patch_form_submission_payment_meta') {
        submission.payment_meta = { ...submission.payment_meta, ...args.p_patch };
        return { data: submission.payment_meta, error: null };
      }
      if (name === 'apply_form_stripe_address_mappings') {
        mappingRpcCalls += 1;
        assert.equal(args.p_organization_id, organizationId);
        return { data: { ok: true, applied: true }, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  await patchFormSubmissionPaymentMeta({
    db,
    tenantId,
    submissionId,
    patch: { stripe_billing_address: snapshot },
  });
  const mappingResult = await retryPersistedStripeAddressMappings({
    db,
    submissionId,
    tenantId,
  });
  assert.equal(JSON.parse(providerSnapshot).line1, '1 High Street');
  assert.equal(submission.payment_meta.stripe_billing_address.line1, '1 High Street');
  assert.equal(mappingResult.applied, true);
  assert.equal(mappingRpcCalls, 1);
});

test('successful charge is recorded before recoverable address capture', () => {
  const source = readFileSync(new URL('../public/form-payment.js', import.meta.url), 'utf8');
  const stripeConfirm = source.slice(source.indexOf("if (row.payment_provider === 'stripe')"));
  assert.ok(
    stripeConfirm.indexOf('markFormSubmissionPaid') < stripeConfirm.indexOf('capturePaymentIntentBillingAddress'),
    'capture failure must occur only after the durable paid transition',
  );
  assert.match(stripeConfirm, /paymentSucceeded:\s*true[\s\S]*retryable:\s*true/);
});

test('reconciliation retries finalized and monthly snapshot repair independently', () => {
  const source = readFileSync(new URL('./formPaymentReconciliation.js', import.meta.url), 'utf8');
  const sweep = source.slice(source.indexOf('Address fulfilment is deliberately independent'));
  assert.match(sweep, /claim_form_stripe_address_mapping_retries/);
  assert.doesNotMatch(sweep, /payment_meta->finalized/);
  assert.match(sweep, /agreement\?\.metadata\?\.stripe_billing_address/);
  assert.match(sweep, /retryPersistedStripeAddressMappings/);
});
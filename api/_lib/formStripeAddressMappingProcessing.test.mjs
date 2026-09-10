import test from 'node:test';
import assert from 'node:assert/strict';
import {
  processPersistedStripeAddressMappings,
  retryPersistedStripeAddressMappings,
  StripeAddressMappingError,
} from './formStripeAddressMappingProcessing.js';
import { buildStripeAddressTargetResolution } from '../../shared/formStripeAddressMappings.js';

const address = {
  line1: '10 High Street',
  line2: null,
  city: 'Leeds',
  state: 'West Yorkshire',
  postal_code: 'LS1 1AA',
  country: 'GB',
  formatted: '10 High Street\nLeeds, West Yorkshire\nLS1 1AA\nGB',
};
const emptyForm = { field_mappings: [], entity_pipelines: {} };
const config = {
  version: 1,
  mappings: [{
    source: 'formatted',
    target_entity: 'organization',
    target_type: 'core',
    target_field: 'invoicing_address',
  }],
  target_resolution: buildStripeAddressTargetResolution(emptyForm, [{
    source: 'formatted',
    target_entity: 'organization',
    target_type: 'core',
    target_field: 'invoicing_address',
  }]),
};

function queryResult(result) {
  const query = {
    select() { return query; },
    eq() { return query; },
    maybeSingle() { return Promise.resolve(result); },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return query;
}

test('valid empty mapping config preserves legacy path without ledger access', async () => {
  const result = await processPersistedStripeAddressMappings({
    db: { from() { throw new Error('no provenance or ledger access expected'); } },
    tenantId: 'tenant-1',
    submission: {
      id: 'submission-1',
      tenant_id: 'tenant-1',
      payment_meta: {
        stripe_address_mapping_config: {
          version: 1,
          mappings: [],
          target_resolution: buildStripeAddressTargetResolution(emptyForm, []),
        },
      },
    },
  });
  assert.deepEqual(result, { configured: true, applied: false, empty: true });
});

test('annual Stripe mapping uses persisted snapshot and atomic RPC', async () => {
  let rpcArgs;
  const db = {
    from(table) {
      if (table === 'form_stripe_address_mapping_ledger') {
        return queryResult({ data: null, error: null });
      }
      assert.equal(table, 'form_submission_entity_creation');
      return queryResult({
        data: [{ entity_type: 'organization', entity_id: 'org-1' }],
        error: null,
      });
    },
    async rpc(name, args) {
      assert.equal(name, 'apply_form_stripe_address_mappings');
      rpcArgs = args;
      return { data: { ok: true, applied: true }, error: null };
    },
  };
  const result = await processPersistedStripeAddressMappings({
    db,
    tenantId: 'tenant-1',
    submission: {
      id: 'submission-1',
      tenant_id: 'tenant-1',
      payment_provider: 'stripe',
      payment_status: 'paid',
      payment_meta: {
        stripe_address_mapping_config: config,
        stripe_billing_address: address,
      },
    },
    organizationId: 'org-1',
    currentForm: { field_mappings: [], entity_pipelines: {} },
  });
  assert.equal(result.applied, true);
  assert.deepEqual(rpcArgs.p_address, {
    ...address,
    country: 'United Kingdom',
    country_code: 'GB',
  });
});

test('monthly mapping remains pending until a paid invoice is recorded', async () => {
  let rpcCalled = false;
  const db = {
    from(table) {
      if (table === 'form_stripe_address_mapping_ledger') {
        return queryResult({ data: null, error: null });
      }
      assert.equal(table, 'membership_payment_plans');
      return queryResult({ data: { metadata: { paid_invoice_ids: [] } }, error: null });
    },
    async rpc() {
      rpcCalled = true;
      return { data: { ok: true }, error: null };
    },
  };
  const result = await processPersistedStripeAddressMappings({
    db,
    tenantId: 'tenant-1',
    submission: {
      id: 'submission-1',
      tenant_id: 'tenant-1',
      payment_provider: 'stripe_monthly_card',
      payment_status: 'setup_complete',
      payment_meta: {
        monthly_card: { agreement_id: 'agreement-1' },
        stripe_address_mapping_config: config,
        stripe_billing_address: address,
      },
    },
    organizationId: 'org-1',
    currentForm: { field_mappings: [], entity_pipelines: {} },
  });
  assert.equal(result.pending, true);
  assert.equal(result.reason, 'first_payment_not_paid');
  assert.equal(rpcCalled, false);
});

test('another payment provider is rejected without writes', async () => {
  await assert.rejects(
    processPersistedStripeAddressMappings({
      db: {
        from(table) {
          assert.equal(table, 'form_stripe_address_mapping_ledger');
          return queryResult({ data: null, error: null });
        },
      },
      tenantId: 'tenant-1',
      submission: {
        id: 'submission-1',
        tenant_id: 'tenant-1',
        payment_provider: 'gocardless',
        payment_status: 'paid',
        payment_meta: {
          stripe_address_mapping_config: config,
          stripe_billing_address: address,
        },
      },
      organizationId: 'org-1',
    }),
    error => error instanceof StripeAddressMappingError
      && error.code === 'PAYMENT_PROVIDER_INVALID',
  );
});

test('a selected organization reference does not authorize an address mutation', async () => {
  const db = {
    from(table) {
      if (table === 'form_stripe_address_mapping_ledger') {
        return queryResult({ data: null, error: null });
      }
      assert.equal(table, 'form_submission_entity_creation');
      return queryResult({ data: [], error: null });
    },
  };
  await assert.rejects(
    processPersistedStripeAddressMappings({
      db,
      tenantId: 'tenant-1',
      submission: {
        id: 'submission-1',
        tenant_id: 'tenant-1',
        payment_provider: 'stripe',
        payment_status: 'paid',
        payment_meta: {
          stripe_address_mapping_config: config,
          stripe_billing_address: address,
        },
      },
      organizationId: 'selected-org',
      authorization: { verifiedOrganizationId: 'owned-org' },
      currentForm: { field_mappings: [], entity_pipelines: {} },
    }),
    error => error.code === 'STRUCTURED_ACTION_FORBIDDEN',
  );
});

test('persisted snapshot rejects a conflicting current ordinary mapping after Stripe config removal', async () => {
  await assert.rejects(
    processPersistedStripeAddressMappings({
      db: {
        from(table) {
          assert.equal(table, 'form_stripe_address_mapping_ledger');
          return queryResult({ data: null, error: null });
        },
      },
      tenantId: 'tenant-1',
      submission: {
        id: 'submission-1',
        tenant_id: 'tenant-1',
        payment_provider: 'stripe',
        payment_status: 'paid',
        payment_meta: {
          stripe_address_mapping_config: config,
          stripe_billing_address: address,
        },
      },
      organizationId: 'org-1',
      currentForm: {
        fields: [{ type: 'payment', payment_providers: [] }],
        entity_pipelines: {
          organisations: [{
            isPrimary: true,
            mappings: [{
              target_type: 'core',
              target_field: 'invoicing_address',
            }],
          }],
        },
      },
    }),
    error => error instanceof StripeAddressMappingError
      && error.code === 'STRIPE_ADDRESS_TARGET_RESOLUTION_CHANGED',
  );
});

test('retry reloads targets instead of accepting caller-selected entity ids', async () => {
  const tables = [];
  const db = {
    from(table) {
      tables.push(table);
      if (table === 'form_submission') {
        return queryResult({
          data: {
            id: 'submission-1',
            tenant_id: 'tenant-1',
            payment_provider: 'stripe',
            payment_status: 'paid',
            payment_meta: {},
            created_member_id: 'member-persisted',
          },
          error: null,
        });
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  const result = await retryPersistedStripeAddressMappings({
    db,
    submissionId: 'submission-1',
    tenantId: 'tenant-1',
  });
  assert.deepEqual(result, { configured: false, applied: false });
  assert.deepEqual(tables, ['form_submission']);
});

test('retry completes from pre-RPC target checkpoint when submission linkage is null', async () => {
  const calls = [];
  const submission = {
    id: 'submission-checkpoint',
    form_id: 'form-1',
    tenant_id: 'tenant-1',
    submitted_by_email: null,
    payment_provider: 'stripe',
    payment_status: 'paid',
    created_member_id: null,
    created_organization_id: null,
    organization_id: null,
    payment_meta: {
      verified_admin_access: true,
      stripe_address_mapping_config: config,
      stripe_billing_address: address,
    },
  };
  const db = {
    from(table) {
      calls.push(table);
      if (table === 'form_submission') return queryResult({ data: submission, error: null });
      if (table === 'form_stripe_address_mapping_ledger') return queryResult({ data: null, error: null });
      if (table === 'form_stripe_address_mapping_target') {
        return queryResult({
          data: [{ entity_type: 'organization', entity_id: 'organization-checkpoint' }],
          error: null,
        });
      }
      if (table === 'form_submission_entity_creation') {
        return queryResult({ data: [], error: null });
      }
      if (table === 'form') return queryResult({ data: emptyForm, error: null });
      throw new Error(`unexpected table ${table}`);
    },
    async rpc(name, args) {
      assert.equal(name, 'apply_form_stripe_address_mappings');
      assert.equal(args.p_organization_id, 'organization-checkpoint');
      return { data: { ok: true, applied: true }, error: null };
    },
  };
  const result = await retryPersistedStripeAddressMappings({
    db,
    submissionId: submission.id,
    tenantId: submission.tenant_id,
  });
  assert.equal(result.applied, true);
  assert.ok(calls.includes('form_stripe_address_mapping_target'));
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFormStripeAddressMappingConfig } from './formStripeAddressMappingConfig.js';

function dbWith(fields, error = null) {
  const result = { data: fields, error };
  const chain = {
    select() { return this; },
    eq() { return this; },
    then(resolve) { return Promise.resolve(result).then(resolve); },
  };
  return { from: table => {
    assert.equal(table, 'preference_field');
    return chain;
  } };
}

const baseForm = {
  entity_pipelines: { members: [{ mappings: [] }], organisations: [] },
  fields: [{
    type: 'payment',
    stripe_billing_address_mappings: [{
      source: 'country',
      target_entity: 'member',
      target_type: 'custom',
      target_field: 'country-field',
    }],
  }],
};

test('server validator accepts an active tenant custom destination', async () => {
  const result = await validateFormStripeAddressMappingConfig({
    supabase: dbWith([{
      id: 'country-field',
      label: 'Country',
      field_type: 'country',
      entity_scope: 'member',
      is_active: true,
    }]),
    tenantId: 'tenant-1',
    form: baseForm,
  });
  assert.equal(result.ok, true);
});

test('server validator rejects unavailable tenant destinations', async () => {
  const result = await validateFormStripeAddressMappingConfig({
    supabase: dbWith([]),
    tenantId: 'tenant-1',
    form: baseForm,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_STRIPE_ADDRESS_MAPPINGS');
  assert.match(result.error, /unavailable or incompatible/);
});

test('server validator rejects a non-array contract value', async () => {
  const result = await validateFormStripeAddressMappingConfig({
    supabase: dbWith([]),
    tenantId: 'tenant-1',
    form: {
      ...baseForm,
      fields: [{ type: 'payment', stripe_billing_address_mappings: null }],
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /must be an array/);
});

test('server validator prohibits mappings on nested Membership Payment fields', async () => {
  const result = await validateFormStripeAddressMappingConfig({
    supabase: dbWith([]),
    tenantId: 'tenant-1',
    form: {
      fields: [{
        type: 'repeatable_rows',
        children: [{
          type: 'membership_payment',
          stripe_billing_address_mappings: [],
        }],
      }],
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /only supported on Payment fields/);
});
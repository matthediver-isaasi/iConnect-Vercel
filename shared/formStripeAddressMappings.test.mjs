import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStripeAddressTargetResolution,
  resolvePrimaryFormEntities,
  stripeAddressDestinationOptions,
  validateStripeAddressTargetResolution,
  validateStripeAddressMappings,
} from './formStripeAddressMappings.js';

const form = {
  application_level: 'member',
  entity_pipelines: {
    members: [{ mappings: [] }],
    organisations: [{ mappings: [] }],
  },
};
const customFields = [
  { id: 'member-address', label: 'Address', field_type: 'text', entity_scope: 'member', is_active: true },
  { id: 'org-country', label: 'Country', field_type: 'country', entity_scope: 'organization', is_active: true },
  { id: 'foreign', label: 'Foreign', field_type: 'text', entity_scope: 'member', tenant_id: 'other' },
  { id: 'file', label: 'File', field_type: 'file', entity_scope: 'member', is_active: true },
];

test('resolves only a single primary pipeline per entity', () => {
  assert.equal(resolvePrimaryFormEntities(form).member.available, true);
  assert.equal(resolvePrimaryFormEntities({
    entity_pipelines: { members: [{}, {}] },
  }).member.ambiguous, true);
  const explicit = resolvePrimaryFormEntities({
    entity_pipelines: { members: [{ id: 'secondary' }, { id: 'primary', isPrimary: true }] },
  }).member;
  assert.equal(explicit.available, true);
  assert.equal(explicit.pipeline.id, 'primary');
  assert.equal(resolvePrimaryFormEntities({
    auto_create_entity: true,
    create_entity_type: 'organization',
    entity_action: 'create',
  }).organization.legacy, true);
});

test('excludes calculated and read-only custom destinations', () => {
  const options = stripeAddressDestinationOptions({
    form,
    customFields: [
      { id: 'ok', field_type: 'text', entity_scope: 'member' },
      { id: 'calculated', field_type: 'text', entity_scope: 'member', is_calculated: true },
      { id: 'readonly', field_type: 'text', entity_scope: 'member', read_only: true },
      { id: 'formula', field_type: 'text', entity_scope: 'member', formula: 'first + last' },
    ],
  });
  assert.deepEqual(
    options.find(group => group.value === 'member').options.map(option => option.target_field),
    ['ok'],
  );
});

test('returns writable core and custom destination options', () => {
  const options = stripeAddressDestinationOptions({ form, customFields });
  assert.deepEqual(options.find(group => group.value === 'member').options.map(item => item.target_field), ['member-address', 'foreign']);
  assert.deepEqual(options.find(group => group.value === 'organization').options.map(item => item.target_field), ['invoicing_address', 'org-country']);
});

test('accepts the canonical mapping shape', () => {
  const result = validateStripeAddressMappings({
    form,
    customFields,
    mappings: [
      { source: 'line1', target_entity: 'member', target_type: 'custom', target_field: 'member-address' },
      { source: 'formatted', target_entity: 'organization', target_type: 'core', target_field: 'invoicing_address' },
    ],
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('rejects ambiguity, duplicate destinations, unsupported fields, and form mapping conflicts', () => {
  const conflictingForm = {
    ...form,
    entity_pipelines: {
      ...form.entity_pipelines,
      members: [
        { mappings: [{ target_type: 'custom', target_field: 'member-address' }] },
        { mappings: [] },
      ],
    },
  };
  const result = validateStripeAddressMappings({
    form: conflictingForm,
    customFields,
    mappings: [
      { source: 'line1', target_entity: 'member', target_type: 'custom', target_field: 'member-address' },
      { source: 'line1', target_entity: 'member', target_type: 'custom', target_field: 'missing', extra: true },
    ],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /more than one primary record/);
  assert.match(result.errors.join(' '), /unsupported properties/);
});

test('allows one Stripe source to map to multiple distinct destinations', () => {
  const country = validateStripeAddressMappings({
    form,
    customFields,
    mappings: [
      { source: 'country', target_entity: 'member', target_type: 'custom', target_field: 'member-address' },
      { source: 'country', target_entity: 'organization', target_type: 'custom', target_field: 'org-country' },
    ],
  });
  assert.deepEqual(country, { valid: true, errors: [] });

  const formatted = validateStripeAddressMappings({
    form,
    customFields,
    mappings: [
      { source: 'formatted', target_entity: 'member', target_type: 'custom', target_field: 'member-address' },
      { source: 'formatted', target_entity: 'organization', target_type: 'core', target_field: 'invoicing_address' },
    ],
  });
  assert.deepEqual(formatted, { valid: true, errors: [] });
});

test('legacy ordinary mappings without target_type conflict as core mappings', () => {
  const legacyForm = {
    auto_create_entity: true,
    create_entity_type: 'organization',
    entity_action: 'create',
    application_level: 'organization',
    field_mappings: [{ target_field: 'invoicing_address' }],
    entity_pipelines: { members: [], organisations: [] },
  };
  const result = validateStripeAddressMappings({
    form: legacyForm,
    mappings: [{
      source: 'formatted',
      target_entity: 'organization',
      target_type: 'core',
      target_field: 'invoicing_address',
    }],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /conflicts with another form mapping/);
});

test('target resolution snapshot is stable by key order and detects pipeline redirects', () => {
  const checkoutForm = {
    entity_pipelines: {
      members: [{ id: 'primary-member', isPrimary: true, action: 'upsert', mappings: [] }],
      organisations: [],
    },
    field_mappings: [],
    create_entity_type: 'member',
    entity_action: 'upsert',
  };
  const mappings = [{
    source: 'line1',
    target_entity: 'member',
    target_type: 'custom',
    target_field: 'member-address',
  }];
  const snapshot = buildStripeAddressTargetResolution(checkoutForm, mappings);
  assert.deepEqual(snapshot.entities, ['member']);
  assert.equal(validateStripeAddressTargetResolution({
    entity_action: 'upsert',
    create_entity_type: 'member',
    field_mappings: [],
    entity_pipelines: {
      organisations: [],
      members: [{ mappings: [], action: 'upsert', isPrimary: true, id: 'primary-member' }],
    },
  }, snapshot).valid, true);
  const redirected = structuredClone(checkoutForm);
  redirected.entity_pipelines.members[0].id = 'different-primary';
  const result = validateStripeAddressTargetResolution(redirected, snapshot);
  assert.equal(result.valid, false);
  assert.match(result.error, /changed after Stripe checkout/);
});

test('implicit legacy core and custom field bindings conflict only on the fallback path', () => {
  const implicitForm = {
    ...form,
    field_mappings: [],
    fields: [
      { id: 'invoice', core_field_mapping: 'organization.invoicing_address' },
      { id: 'member-address-answer', preference_field_id: 'member-address' },
    ],
  };
  const coreConflict = validateStripeAddressMappings({
    form: implicitForm,
    customFields,
    mappings: [{
      source: 'formatted',
      target_entity: 'organization',
      target_type: 'core',
      target_field: 'invoicing_address',
    }],
  });
  assert.match(coreConflict.errors.join(' '), /conflicts with another form mapping/);

  const customConflict = validateStripeAddressMappings({
    form: implicitForm,
    customFields,
    mappings: [{
      source: 'line1',
      target_entity: 'member',
      target_type: 'custom',
      target_field: 'member-address',
    }],
  });
  assert.match(customConflict.errors.join(' '), /conflicts with another form mapping/);

  const modernPathForm = {
    ...implicitForm,
    field_mappings: [{
      target_entity: 'member',
      target_type: 'core',
      target_field: 'email',
      source_field_id: 'email',
    }],
  };
  const inactiveImplicit = validateStripeAddressMappings({
    form: modernPathForm,
    customFields,
    mappings: [{
      source: 'formatted',
      target_entity: 'organization',
      target_type: 'core',
      target_field: 'invoicing_address',
    }],
  });
  assert.deepEqual(inactiveImplicit, { valid: true, errors: [] });
});
import '../../scripts/test-support/isolation-boundary.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeProcessor } from './processApplicationOrganizationName.test.mjs';
import { applicantConfigurationDigest } from '../_lib/formApplicantContinuation.js';

const SYNTHETIC_ORGANIZATION_ID = '11111111-2222-4333-8444-555555555555';
const TENANT_ID = 'tenant-runtime-org';
const ORGANIZATION_NAME_FIELD_ID = 'organization-name-prefill';

function organizationNamePayload({ fieldType = 'text', value }) {
  return {
    fields: [{
      id: ORGANIZATION_NAME_FIELD_ID,
      type: fieldType,
      locked: true,
      prefill_field: 'org:name',
    }],
    form_values: {
      [ORGANIZATION_NAME_FIELD_ID]: value,
    },
    application_level: 'organization',
    create_entity_type: 'organization',
    entity_action: 'create',
    member_entity_action: 'none',
    organization_entity_action: 'upsert',
    entity_pipelines: {
      organisations: [{
        id: 'organization-primary',
        isPrimary: true,
        mappings: [{
          source_type: 'field',
          source_field_id: ORGANIZATION_NAME_FIELD_ID,
          target_type: 'core',
          target_entity: 'organization',
          target_field: 'name',
        }],
      }],
    },
  };
}

function sanitizedPersistedForm(payload) {
  // Reconstruct only invokeProcessor's synthetic persisted form. No production
  // form configuration or configuration snapshot is stored in this fixture.
  return {
    id: 'form-runtime-org',
    tenant_id: TENANT_ID,
    pages: [],
    visibility_rules: [],
    field_mappings: [],
    application_level: 'organization',
    create_entity_type: 'organization',
    entity_action: 'create',
    member_entity_action: 'none',
    organization_entity_action: 'upsert',
    additional_member_creations: [],
    ...payload,
    fields: payload.fields,
    entity_pipelines: payload.entity_pipelines,
  };
}

test('characterization: original locked prefill text inserts Testing University', async () => {
  const result = await invokeProcessor({
    ...organizationNamePayload({ value: 'Testing University' }),
    organization_entity_action: 'create',
  }, {
    // This sanitized fixture is explicitly admin-authorized. Whether the
    // historical request had equivalent authorization is unknown.
    verifiedAdminAccess: true,
  });

  assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
  assert.equal(
    result.inserts.find(entry => entry.table === 'organization')?.payload.name,
    'Testing University',
  );
  assert.equal(result.submission.tenant_id, TENANT_ID);
});

test('characterization: continuation-authorized later persisted text UUID overwrites the existing organization name', async () => {
  const payload = organizationNamePayload({
    value: SYNTHETIC_ORGANIZATION_ID,
  });
  payload.organization_entity_action = 'update';
  const result = await invokeProcessor(payload, {
    existingOrganization: {
      id: SYNTHETIC_ORGANIZATION_ID,
      tenant_id: TENANT_ID,
      name: 'Testing University',
    },
    submissionOverrides: {
      organization_id: SYNTHETIC_ORGANIZATION_ID,
    },
    verifiedAdminAccess: false,
    applicantContinuationGrant: {
      submission_id: 'submission-runtime-org',
      form_id: 'form-runtime-org',
      tenant_id: TENANT_ID,
      organization_id: SYNTHETIC_ORGANIZATION_ID,
      member_ids: [],
      created_at: '2025-01-01T00:00:00.000Z',
      bound_at: '2025-01-02T00:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
      revoked_at: null,
      configuration_digest: applicantConfigurationDigest(sanitizedPersistedForm(payload)),
    },
  });

  assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
  assert.equal(result.response.body.organization_id, SYNTHETIC_ORGANIZATION_ID);
  assert.equal(
    result.updates.find(entry => entry.table === 'organization')?.payload.name,
    SYNTHETIC_ORGANIZATION_ID,
  );
});

test('characterization control: organization dropdown UUID does not write the name', async () => {
  const result = await invokeProcessor(organizationNamePayload({
    fieldType: 'organisation_dropdown',
    value: SYNTHETIC_ORGANIZATION_ID,
  }), {
    existingOrganization: {
      id: SYNTHETIC_ORGANIZATION_ID,
      tenant_id: TENANT_ID,
      name: 'Testing University',
    },
    submissionOverrides: {
      organization_id: SYNTHETIC_ORGANIZATION_ID,
    },
    verifiedAdminAccess: true,
  });

  assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
  assert.equal(result.response.body.organization_id, SYNTHETIC_ORGANIZATION_ID);
  assert.equal(
    result.updates.some(entry =>
      entry.table === 'organization'
      && Object.hasOwn(entry.payload, 'name')),
    false,
  );
});
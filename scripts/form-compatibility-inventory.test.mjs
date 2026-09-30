import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyForm,
  makeFixture,
  readAllForms,
  sanitizeStructure,
} from './form-compatibility-inventory.mjs';

test('keyset pagination reads every form without overlap', async () => {
  const source = Array.from({ length: 205 }, (_, index) => ({
    id: String(index + 1).padStart(36, '0'),
    tenant_id: 'tenant',
  }));
  const cursors = [];
  const client = {
    async query(_sql, [cursor, limit]) {
      cursors.push(cursor);
      const start = cursor == null ? 0 : source.findIndex(row => row.id === cursor) + 1;
      return { rows: source.slice(start, start + limit) };
    },
  };
  const result = await readAllForms(client, 100);
  assert.equal(result.pages, 3);
  assert.deepEqual(result.rows, source);
  assert.deepEqual(cursors, [null, source[99].id, source[199].id]);
});

test('classifier covers modern pipeline identity, existing updates and writes', () => {
  const classification = classifyForm({
    id: 'form',
    tenant_id: 'tenant',
    require_authentication: false,
    prefill_source: 'organization',
    organization_entity_action: 'update',
    member_entity_action: 'create',
    entity_pipelines: {
      members: [{
        uniqueness_key: 'email',
        login_enabled: true,
        mappings: [
          { target_type: 'custom', target_field: 'custom-id' },
          { target_type: 'core', target_field: 'invoicing_email' },
        ],
      }],
      organisations: [{
        uniqueness_key: 'name',
        mappings: [
          { target_type: 'core', target_field: 'name' },
          { target_type: 'core', target_field: 'invoicing_address' },
        ],
      }],
    },
  });
  assert.ok(classification.families.includes('entity-pipelines-modern'));
  assert.deepEqual(classification.existingRecordOperations, ['member', 'organization']);
  assert.equal(classification.mutationContract.hasExistingRecordMutation, true);
  assert.equal(classification.mutationContract.accessAssessment.ok, false);
  assert.deepEqual(classification.identityKeys, ['email', 'name']);
  assert.equal(classification.customWriteCount, 1);
  assert.equal(classification.invoiceWriteCount, 2);
  assert.equal(classification.access, 'public');
});

test('family classifier ignores none actions and accepts structured action arrays', () => {
  const none = classifyForm({
    id: 'form',
    tenant_id: 'tenant',
    entity_action: 'none',
    member_entity_action: 'none',
    organization_entity_action: 'none',
  });
  assert.deepEqual(none.families, ['display-only']);
  assert.deepEqual(none.actionModes, []);

  const structured = classifyForm({
    id: 'form',
    tenant_id: 'tenant',
    entity_action: 'none',
    structured_actions: [{ entity: 'organization', operation: 'create' }],
  });
  assert.ok(structured.families.includes('structured-actions-current'));
  assert.equal(structured.mutationContract.targets.organization.classification, 'create_only');
  assert.deepEqual(structured.actionModes, ['create']);

  const unsupportedApplicant = classifyForm({
    id: 'form',
    tenant_id: 'tenant',
    structured_actions: [{
      id: 'upsert-org',
      entity: 'organization',
      operation: 'upsert',
    }],
  });
  assert.equal(unsupportedApplicant.mutationContract.applicantContinuationSupported, false);
  assert.deepEqual(unsupportedApplicant.mutationContract.applicantContinuationLimitations, [{
    family: 'structured_actions',
    operation: 'upsert',
  }]);
});

test('fixture sanitizer removes content and aliases non-target identifiers', () => {
  const sanitized = sanitizeStructure({
    label: 'A real person',
    static_value: 'secret content',
    role_id: '11111111-1111-1111-1111-111111111111',
    type: 'email',
    target_field: '33333333-3333-3333-3333-333333333333',
    arbitrary: 'private@example.test',
  });
  assert.equal(Object.hasOwn(sanitized, 'label'), false);
  assert.equal(Object.hasOwn(sanitized, 'static_value'), false);
  assert.match(sanitized.role_id, /^ref_[a-f0-9]{12}$/);
  assert.match(sanitized.target_field, /^ref_[a-f0-9]{12}$/);
  assert.equal(sanitized.type, 'email');
  assert.equal(sanitized.arbitrary, '<redacted>');

  const fixture = makeFixture({
    id: '57b94fc2-359d-434c-acd6-794865797ade',
    tenant_id: '22222222-2222-2222-2222-222222222222',
    fields: [{ id: 'field_1', type: 'text', label: 'Name' }],
  });
  assert.equal(fixture.formId, '57b94fc2-359d-434c-acd6-794865797ade');
  assert.match(fixture.tenantAlias, /^tenant_[a-f0-9]{12}$/);
  assert.equal(JSON.stringify(fixture).includes('"label":"Name"'), false);
});
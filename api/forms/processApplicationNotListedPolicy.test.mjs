import '../../scripts/test-support/isolation-boundary.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeProcessor } from './processApplicationOrganizationName.test.mjs';
import {
  FORM_NOT_LISTED_TEXT_KEY,
  FORM_NOT_LISTED_VALUE,
} from '../../shared/formNotListedChoice.js';

// processApplicationOrganizationName.test.mjs exposes the shared handler
// fixture used by the public/embedded regressions; its persisted tenant is
// intentionally fixed to this value.
const TENANT_ID = 'tenant-runtime-org';
const MEMBER_ID = 'created-member';
const RELATIONSHIP_ID = 'member-related-organization';
const RELATED_FIELD_ID = 'related-organization';

const relationshipDefinition = {
  id: RELATIONSHIP_ID,
  tenant_id: TENANT_ID,
  status: 'active',
  source_kind: 'member',
  source_custom_object_id: null,
  target_kind: 'organization',
  target_custom_object_id: null,
};

function relatedRecordPayload({
  notListedPolicy = 'include',
  creationConfig = true,
} = {}) {
  const relatedRecord = {
    id: 'member-related-organization-link',
    relationship_definition_id: RELATIONSHIP_ID,
    source_field_id: RELATED_FIELD_ID,
    not_listed_policy: notListedPolicy,
  };
  if (creationConfig) {
    // These properties intentionally live directly on the Related Records
    // link. They are the persisted contract used by the process path; a
    // nested `creation` object must not be accepted as a second shape.
    Object.assign(relatedRecord, {
      identity_mapping: {
        id: 'related-organization-name',
        source_type: 'not_listed_text',
        source_field_id: RELATED_FIELD_ID,
        target_type: 'core',
        target_field_id: 'name',
      },
      companion_mappings: [{
        id: 'related-organization-description',
        source_type: 'field',
        source_field_id: 'related-organization-description',
        target_type: 'core',
        target_field_id: 'description',
      }],
      not_listed_operation: 'create',
    });
  }

  return {
    fields: [
      { id: 'member-email', type: 'email' },
      {
        id: RELATED_FIELD_ID,
        type: 'relationship_dropdown',
        related_kind: 'organization',
        not_listed_choice: { enabled: true, label: 'Not listed' },
      },
      { id: 'related-organization-description', type: 'text' },
    ],
    form_values: {
      'member-email': 'related-record-policy@example.test',
      [RELATED_FIELD_ID]: FORM_NOT_LISTED_VALUE,
      'related-organization-description': 'Created from a paid application',
      [FORM_NOT_LISTED_TEXT_KEY]: {
        [RELATED_FIELD_ID]: 'A newly entered organisation',
      },
    },
    application_level: 'member',
    create_entity_type: 'member',
    entity_action: 'none',
    member_entity_action: 'create',
    organization_entity_action: 'none',
    entity_pipelines: {
      members: [{
        id: 'member-primary',
        isPrimary: true,
        mappings: [{
          id: 'member-email-mapping',
          source_type: 'field',
          source_field_id: 'member-email',
          target_type: 'core',
          target_entity: 'member',
          target_field: 'email',
        }],
        related_records: [relatedRecord],
      }],
      organisations: [],
    },
  };
}

function forgedRequestCopies({ include = true } = {}) {
  const link = {
    id: 'forged-related-link',
    relationship_definition_id: RELATIONSHIP_ID,
    source_field_id: RELATED_FIELD_ID,
    not_listed_policy: include ? 'include' : 'skip',
    identity_mapping: {
      id: 'forged-identity',
      source_type: 'not_listed_text',
      source_field_id: RELATED_FIELD_ID,
      target_type: 'core',
      target_field_id: 'name',
    },
    companion_mappings: [],
    not_listed_operation: 'create',
  };
  return {
    fields: [],
    form_values: {
      [RELATED_FIELD_ID]: include ? 'forged-listed-id' : FORM_NOT_LISTED_VALUE,
      [FORM_NOT_LISTED_TEXT_KEY]: { [RELATED_FIELD_ID]: 'Forged request value' },
    },
    entity_pipelines: {
      members: [{ id: 'forged-primary', isPrimary: true, related_records: [link] }],
      organisations: [],
    },
  };
}

function relatedDatabase() {
  return {
    relationshipDefinitions: [relationshipDefinition],
  };
}

function relatedOrganizationInsert(result) {
  return result.inserts.find(entry => entry.table === 'organization');
}

function relationshipInsert(result) {
  return result.inserts.find(entry =>
    entry.table === 'custom_object_relationship'
    && entry.payload.relationship_definition_id === RELATIONSHIP_ID);
}

for (const [surface, requestBodyOverrides] of [
  ['public signed handoff', forgedRequestCopies({ include: false })],
  ['embedded signed handoff', forgedRequestCopies({ include: false })],
]) {
  test(`${surface} uses persisted Related Records include policy and direct creation mappings`, async () => {
    const result = await invokeProcessor(relatedRecordPayload(), {
      ...relatedDatabase(),
      // Request copies deliberately disagree with every relevant persisted
      // value. The shared processor must reload the saved form and submission
      // before resolving or writing the Not-listed related record.
      requestBodyOverrides,
    });

    assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
    assert.equal(result.response.body.related_records?.success, true);
    assert.equal(result.response.body.related_records?.failed_count, 0);
    assert.deepEqual(relatedOrganizationInsert(result)?.payload, {
      tenant_id: TENANT_ID,
      name: 'A newly entered organisation',
      description: 'Created from a paid application',
    });
    assert.deepEqual(relationshipInsert(result)?.payload, {
      tenant_id: TENANT_ID,
      relationship_definition_id: RELATIONSHIP_ID,
      source_record_id: MEMBER_ID,
      target_record_id: 'created-organization',
    });
    assert.equal(
      result.response.body.related_records.outcomes.some(outcome =>
        outcome.status === 'linked' && outcome.record_id === 'created-organization'),
      true,
    );
  });
}

test('persisted Related Records skip policy ignores a Not-listed value without resolver writes', async () => {
  const result = await invokeProcessor(
    relatedRecordPayload({ notListedPolicy: 'skip', creationConfig: false }),
    {
      ...relatedDatabase(),
      requestBodyOverrides: forgedRequestCopies({ include: true }),
    },
  );

  assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
  assert.equal(result.response.body.related_records?.success, true, JSON.stringify(result.response.body));
  assert.deepEqual(
    result.response.body.related_records?.outcomes.find(outcome => outcome.id === 'member-related-organization-link'),
    {
      id: 'member-related-organization-link',
      entity_type: 'member',
      source_field_id: RELATED_FIELD_ID,
      relationship_definition_id: RELATIONSHIP_ID,
      status: 'skipped',
      reason: 'not_listed_policy_skip',
      intentional: true,
    },
  );
  assert.equal(relatedOrganizationInsert(result), undefined);
  assert.equal(relationshipInsert(result), undefined);
});

test('builder-shaped multi Relationship Dropdown links listed records and resolves only its Not-listed item', async () => {
  const payload = relatedRecordPayload();
  const picker = payload.fields.find(field => field.id === RELATED_FIELD_ID);
  payload.fields.splice(1, 0, { id: 'organization-parent', type: 'organisation_dropdown' });
  picker.selection_mode = 'multiple';
  picker.relationship_definition_id = RELATIONSHIP_ID;
  picker.parent_field_id = 'organization-parent';
  picker.relationship_parent_kind = 'organization';
  picker.relationship_parent_side = 'source';
  payload.form_values['organization-parent'] = 'already-listed-organization';
  payload.form_values[RELATED_FIELD_ID] = ['already-listed-organization', FORM_NOT_LISTED_VALUE];
  payload.application_level = 'organization';
  payload.create_entity_type = 'organization';
  payload.member_entity_action = 'none';
  payload.organization_entity_action = 'upsert';
  payload.entity_pipelines = {
    members: [],
    organisations: [{
      id: 'organization-primary',
      isPrimary: true,
      mappings: [{
        id: 'organization-parent-name',
        source_type: 'field',
        source_field_id: 'organization-parent',
        target_type: 'core',
        target_entity: 'organization',
        target_field: 'organisation_name',
      }],
      related_records: payload.entity_pipelines.members[0].related_records,
    }],
  };
  const result = await invokeProcessor(payload, {
    relationshipDefinitions: [{
      ...relationshipDefinition,
      source_kind: 'organization',
    }],
    relationshipEdges: [{
      id: 'already-linked-listed-organization',
      tenant_id: TENANT_ID,
      relationship_definition_id: RELATIONSHIP_ID,
      source_record_id: 'already-listed-organization',
      target_record_id: 'already-listed-organization',
      archived_at: null,
    }],
    existingOrganization: {
      id: 'already-listed-organization',
      tenant_id: TENANT_ID,
      name: 'Existing listed organisation',
    },
  });

  assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
  assert.equal(result.response.body.related_records?.success, true, JSON.stringify(result.response.body));
  assert.deepEqual(relatedOrganizationInsert(result)?.payload, {
    tenant_id: TENANT_ID,
    name: 'A newly entered organisation',
    description: 'Created from a paid application',
  });
  const edges = result.inserts.filter(entry =>
    entry.table === 'custom_object_relationship'
    && entry.payload.relationship_definition_id === RELATIONSHIP_ID);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].payload.target_record_id, 'created-organization');
  assert.equal(
    result.response.body.related_records.outcomes.filter(outcome => outcome.status === 'linked').length,
    1,
  );
  assert.equal(
    result.response.body.related_records.outcomes.some(outcome =>
      outcome.status === 'already_linked' && outcome.record_id === 'already-listed-organization'),
    true,
  );
});

test('invalid persisted Related Records policy fails closed before resolver or link writes', async () => {
  const result = await invokeProcessor(
    relatedRecordPayload({ notListedPolicy: 'accept-anything' }),
    relatedDatabase(),
  );

  assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
  assert.equal(result.response.body.related_records?.success, false);
  assert.equal(result.response.body.related_records?.outcomes[0]?.reason, 'invalid_configuration');
  assert.match(
    result.response.body.related_records?.outcomes[0]?.error || '',
    /not_listed_policy must be include or skip/i,
  );
  assert.equal(relatedOrganizationInsert(result), undefined);
  assert.equal(relationshipInsert(result), undefined);
});

test('active required Related Records target fields fail before a new target is written', async () => {
  const result = await invokeProcessor(relatedRecordPayload(), {
    ...relatedDatabase(),
    // This field was made required after the form's Related Records mapping
    // was saved. It is deliberately absent from identity/companion mappings.
    preferenceFields: [{
      id: 'organization-new-required-field',
      tenant_id: TENANT_ID,
      entity_scope: 'organization',
      is_active: true,
      is_required: true,
      name: 'new_required_field',
      label: 'New required field',
      field_type: 'text',
    }],
  });

  assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
  assert.equal(result.response.body.related_records?.success, false);
  const outcome = result.response.body.related_records?.outcomes.find(item =>
    item.reason === 'not_listed_record_resolution_failed');
  assert.match(outcome?.error || '', /missing active required organization field mappings or values/i);
  assert.equal(relatedOrganizationInsert(result), undefined);
  assert.equal(relationshipInsert(result), undefined);
});

test('hidden Related Records companions cannot supply a required target preference', async () => {
  const payload = relatedRecordPayload();
  payload.fields = payload.fields.map(field => field.id === 'related-organization-description'
    ? { ...field, starts_hidden: true }
    : field);
  const relatedLink = payload.entity_pipelines.members[0].related_records[0];
  relatedLink.companion_mappings = [{
    id: 'hidden-required-preference',
    source_type: 'field',
    source_field_id: 'related-organization-description',
    target_type: 'custom',
    target_field_id: 'organization-required-hidden-companion',
  }];
  const result = await invokeProcessor(payload, {
    ...relatedDatabase(),
    preferenceFields: [{
      id: 'organization-required-hidden-companion',
      tenant_id: TENANT_ID,
      entity_scope: 'organization',
      is_active: true,
      is_required: true,
      name: 'required_hidden_companion',
      label: 'Required hidden companion',
      field_type: 'text',
    }],
  });

  assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
  assert.equal(result.response.body.related_records?.success, false);
  const outcome = result.response.body.related_records?.outcomes.find(item =>
    item.reason === 'not_listed_record_resolution_failed');
  assert.match(outcome?.error || '', /missing active required organization field mappings or values/i);
  assert.equal(relatedOrganizationInsert(result), undefined);
  assert.equal(relationshipInsert(result), undefined);
});

test('untrusted request copies cannot authorize persisted Not-listed Related Records creation', async () => {
  const result = await invokeProcessor(relatedRecordPayload(), {
    ...relatedDatabase(),
    // The signature was generated for verified_admin_access=true. Altering
    // this request-side authority breaks the signed hop and must be rejected
    // before the primary or Related Records writes begin.
    requestBodyOverrides: {
      ...forgedRequestCopies({ include: true }),
      verified_admin_access: false,
    },
  });

  assert.equal(result.response.statusCode, 403, JSON.stringify(result.response.body));
  assert.equal(result.response.body.code, 'PROCESSING_FORBIDDEN');
  assert.equal(result.inserts.some(entry => entry.table === 'organization'), false);
  assert.equal(result.inserts.some(entry => entry.table === 'custom_object_relationship'), false);
});

test('paid Related Records retry clears only its pending marker after shared processing succeeds', async () => {
  const result = await invokeProcessor(relatedRecordPayload(), {
    ...relatedDatabase(),
    existingMember: {
      id: MEMBER_ID,
      tenant_id: TENANT_ID,
      email: 'related-record-policy@example.test',
      organization_id: null,
      organization_group_id: null,
      role_id: null,
    },
    persistedCreatedMemberId: MEMBER_ID,
    entityProcessingCompletedAt: '2026-09-16T00:00:00.000Z',
    submissionOverrides: {
      payment_status: 'paid',
      payment_reference: 'pi-related-record-policy',
      payment_meta: {
        verified_submitter_member_id: null,
        verified_admin_access: true,
        related_records_pending: true,
        related_records_result: {
          success: false,
          failed_count: 1,
        },
      },
    },
    requestBodyOverrides: forgedRequestCopies({ include: false }),
  });

  assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
  assert.equal(result.response.body.already_processed, true);
  assert.equal(result.response.body.related_records?.success, true);
  const retryUpdate = result.updates.find(update =>
    update.table === 'form_submission'
    && update.payload?.payment_meta?.related_records_pending !== undefined);
  assert.equal(retryUpdate?.payload.payment_meta.related_records_pending, false);
  assert.equal(retryUpdate?.payload.payment_meta.related_records_result.success, true);
  assert.equal(
    retryUpdate?.payload.payment_meta.verified_admin_access,
    true,
    'retry must preserve the persisted payment authority marker',
  );
  assert.deepEqual(relationshipInsert(result)?.payload, {
    tenant_id: TENANT_ID,
    relationship_definition_id: RELATIONSHIP_ID,
    source_record_id: MEMBER_ID,
    target_record_id: 'created-organization',
  });
});

test('tenant mismatch rejects persisted Related Records creation before processing', async () => {
  const result = await invokeProcessor(relatedRecordPayload(), {
    ...relatedDatabase(),
    requestBodyOverrides: {
      tenant_id: 'attacker-tenant',
      ...forgedRequestCopies({ include: true }),
    },
  });

  assert.equal(result.response.statusCode, 403, JSON.stringify(result.response.body));
  assert.equal(result.response.body.code, 'TENANT_MISMATCH');
  assert.equal(result.inserts.some(entry => entry.table === 'organization'), false);
  assert.equal(result.inserts.some(entry => entry.table === 'custom_object_relationship'), false);
});
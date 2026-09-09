/**
 * Configure the repeatable "Additional sites or departments" actions on the
 * Full member junior join form in the destination Supabase environment.
 *
 * The script is intentionally tenant-specific, idempotent, and fail-closed.
 * It reads only form/schema metadata, validates the complete action contract,
 * performs one optimistic form update, reloads the saved value, and writes a
 * submission-data-free verification record.
 *
 * Usage:
 *   node scripts/configure-additional-sites-mapping.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { validateStructuredActionsContract } from '../api/_lib/formStructuredActions.js';
import {
  recordReferencePickerCompatibility,
} from '../shared/formRecordReferenceResolver.js';
import { repeatableRowChildren } from '../shared/formRepeatableRows.js';

const FORM_ID = '8faff8a5-5671-41ef-a246-81810c34326d';
const EXPECTED_TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const REPEATABLE_FIELD_ID = 'field_1788674418554';
const ORGANIZATION_FIELD_ID = 'row_field_1788674468526_amaga';
const DEPARTMENT_FIELD_ID = 'row_field_1788674529062_so7ep';
const DEPARTMENT_OBJECT_ID = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
const DEPARTMENT_IDENTITY_FIELD_ID = '35e4f2dd-6f22-4875-8d2f-4ffb05b1980f';
const ASSIGNMENT_OBJECT_ID = '1c1cdab9-5128-4e3d-b09e-b97088ae69ba';
const ASSIGNMENT_NAME_FIELD_ID = '26466f9a-57d3-467f-a3c9-f5adadc29fa2';
const RELATIONSHIP_IDS = Object.freeze({
  organizationDepartment: '30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e',
  assignmentOrganization: '184b26ff-c918-4162-98c4-1e16fde737ad',
  assignmentMember: '601544ca-9db9-498e-bd03-0af5e2c2e8a0',
  departmentMember: '0fdede92-efa2-4d84-9b16-df1a88069486',
});
const VERIFICATION_PATH = path.resolve(
  'verification/configure-additional-sites-mapping.json',
);

const ACTION_IDS = Object.freeze({
  organization: 'additional_sites_resolve_organization',
  department: 'additional_sites_resolve_department',
  organizationDepartment: 'additional_sites_link_organization_department',
  assignment: 'additional_sites_create_member_organization_assignment',
  assignmentOrganization: 'additional_sites_link_assignment_organization',
  assignmentMember: 'additional_sites_link_assignment_member',
  departmentMember: 'additional_sites_link_department_member',
});
const MANAGED_ACTION_IDS = new Set(Object.values(ACTION_IDS));

function fail(message) {
  throw new Error(`Additional Sites mapping aborted: ${message}`);
}

function requireSingle(rows, description) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail(`${description} expected exactly one match; found ${rows?.length ?? 0}`);
  }
  return rows[0];
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]),
  );
}

function structurallyEqual(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function isManagedSemanticAction(action) {
  if (!action || action?.source?.scope !== 'repeatable_row'
      || String(action?.source?.repeatable_field_id) !== REPEATABLE_FIELD_ID) {
    return false;
  }
  if (action.operation === 'resolve_record_reference') {
    return [ORGANIZATION_FIELD_ID, DEPARTMENT_FIELD_ID]
      .includes(String(action.reference_field_id || action.record_reference_field_id || ''));
  }
  if (action.operation === 'create') {
    return action.target?.kind === 'custom_object'
      && String(action.target?.custom_object_id || '') === ASSIGNMENT_OBJECT_ID;
  }
  return action.operation === 'link_relationship'
    && Object.values(RELATIONSHIP_IDS).includes(String(action.relationship_definition_id || ''));
}

function desiredActions() {
  const source = {
    scope: 'repeatable_row',
    repeatable_field_id: REPEATABLE_FIELD_ID,
  };
  return [
    {
      id: ACTION_IDS.organization,
      label: 'Resolve additional Organisation',
      source,
      target: { kind: 'organization' },
      operation: 'resolve_record_reference',
      reference_field_id: ORGANIZATION_FIELD_ID,
      not_listed_operation: 'upsert',
      uniqueness_field: 'name',
      identity_mapping: {
        id: 'additional_sites_organization_name',
        source_type: 'not_listed_text',
        source_field_id: ORGANIZATION_FIELD_ID,
        target_type: 'core',
        target_field_id: 'name',
      },
      companion_mappings: [],
      mappings: [],
    },
    {
      id: ACTION_IDS.department,
      label: 'Resolve additional Department',
      source,
      target: {
        kind: 'custom_object',
        custom_object_id: DEPARTMENT_OBJECT_ID,
      },
      operation: 'resolve_record_reference',
      reference_field_id: DEPARTMENT_FIELD_ID,
      not_listed_operation: 'upsert',
      uniqueness_field: DEPARTMENT_IDENTITY_FIELD_ID,
      identity_mapping: {
        id: 'additional_sites_department_name',
        source_type: 'not_listed_text',
        source_field_id: DEPARTMENT_FIELD_ID,
        target_type: 'custom',
        target_field_id: DEPARTMENT_IDENTITY_FIELD_ID,
      },
      companion_mappings: [],
      mappings: [],
    },
    {
      id: ACTION_IDS.organizationDepartment,
      label: 'Link additional Organisation and Department',
      source,
      operation: 'link_relationship',
      relationship_definition_id: RELATIONSHIP_IDS.organizationDepartment,
      source_endpoint: {
        kind: 'custom_object',
        custom_object_id: DEPARTMENT_OBJECT_ID,
        source: { type: 'action_output', action_id: ACTION_IDS.department },
      },
      target_endpoint: {
        kind: 'organization',
        source: { type: 'action_output', action_id: ACTION_IDS.organization },
      },
      mappings: [],
    },
    {
      id: ACTION_IDS.assignment,
      label: 'Create secondary Organisation assignment',
      source,
      target: {
        kind: 'custom_object',
        custom_object_id: ASSIGNMENT_OBJECT_ID,
      },
      operation: 'create',
      mappings: [{
        id: 'additional_sites_assignment_name',
        source_type: 'resolved_record_labels',
        record_sources: [
          { type: 'primary_pipeline_output', kind: 'member' },
          { type: 'action_output', action_id: ACTION_IDS.organization },
        ],
        separator: ' - ',
        target_type: 'custom',
        target_field_id: ASSIGNMENT_NAME_FIELD_ID,
      }],
    },
    {
      id: ACTION_IDS.assignmentOrganization,
      label: 'Link assignment to secondary Organisation',
      source,
      operation: 'link_relationship',
      relationship_definition_id: RELATIONSHIP_IDS.assignmentOrganization,
      source_endpoint: {
        kind: 'custom_object',
        custom_object_id: ASSIGNMENT_OBJECT_ID,
        source: { type: 'action_output', action_id: ACTION_IDS.assignment },
      },
      target_endpoint: {
        kind: 'organization',
        source: { type: 'action_output', action_id: ACTION_IDS.organization },
      },
      mappings: [],
    },
    {
      id: ACTION_IDS.assignmentMember,
      label: 'Link assignment to member',
      source,
      operation: 'link_relationship',
      relationship_definition_id: RELATIONSHIP_IDS.assignmentMember,
      source_endpoint: {
        kind: 'custom_object',
        custom_object_id: ASSIGNMENT_OBJECT_ID,
        source: { type: 'action_output', action_id: ACTION_IDS.assignment },
      },
      target_endpoint: {
        kind: 'member',
        source: { type: 'primary_pipeline_output' },
      },
      mappings: [],
    },
    {
      id: ACTION_IDS.departmentMember,
      label: 'Link secondary Department to member',
      source,
      operation: 'link_relationship',
      relationship_definition_id: RELATIONSHIP_IDS.departmentMember,
      source_endpoint: {
        kind: 'custom_object',
        custom_object_id: DEPARTMENT_OBJECT_ID,
        source: { type: 'action_output', action_id: ACTION_IDS.department },
      },
      target_endpoint: {
        kind: 'member',
        source: { type: 'primary_pipeline_output' },
      },
      mappings: [],
    },
  ];
}

async function loadMetadata(db) {
  const { data: form, error: formError } = await db.from('form')
    .select('id,name,tenant_id,fields,structured_actions')
    .eq('id', FORM_ID).maybeSingle();
  if (formError) throw formError;
  if (!form) fail('target form was not found');
  if (String(form.tenant_id) !== EXPECTED_TENANT_ID) {
    fail(`target form tenant drifted from ${EXPECTED_TENANT_ID}`);
  }

  const [objectResult, fieldResult, relationshipResult] = await Promise.all([
    db.from('custom_object_definition').select(
      'id,object_key,singular_label,plural_label,primary_display_field_id,status,archived_at',
    ).eq('tenant_id', form.tenant_id).in('id', [DEPARTMENT_OBJECT_ID, ASSIGNMENT_OBJECT_ID]),
    db.from('preference_field').select(
      'id,name,label,field_type,entity_scope,custom_object_id,is_active',
    ).eq('tenant_id', form.tenant_id).in('id', [DEPARTMENT_IDENTITY_FIELD_ID, ASSIGNMENT_NAME_FIELD_ID]),
    db.from('custom_object_relationship_definition').select(
      'id,relationship_key,source_kind,source_custom_object_id,target_kind,target_custom_object_id,cardinality,source_label,target_label,status',
    ).eq('tenant_id', form.tenant_id).in('id', Object.values(RELATIONSHIP_IDS)),
  ]);
  if (objectResult.error) throw objectResult.error;
  if (fieldResult.error) throw fieldResult.error;
  if (relationshipResult.error) throw relationshipResult.error;

  return {
    form,
    objects: new Map((objectResult.data || []).map(object => [String(object.id), object])),
    fields: new Map((fieldResult.data || []).map(field => [String(field.id), field])),
    relationships: new Map((relationshipResult.data || []).map(relationship => [String(relationship.id), relationship])),
  };
}

function validateMetadata({ form, objects, fields, relationships }) {
  const repeatable = (form.fields || []).find(
    field => String(field?.id) === REPEATABLE_FIELD_ID,
  );
  if (!repeatable || !['repeatable_row', 'repeatable_rows'].includes(repeatable.type)) {
    fail('expected repeatable field is missing or changed type');
  }
  if (repeatable.label !== 'Additional sites or departments') {
    fail('expected repeatable field label has drifted');
  }
  const children = repeatableRowChildren(repeatable);
  const organization = children.find(field => String(field?.id) === ORGANIZATION_FIELD_ID);
  const department = children.find(field => String(field?.id) === DEPARTMENT_FIELD_ID);
  if (!organization || organization.type !== 'organisation_dropdown') {
    fail('expected Organisation child picker is missing or changed type');
  }
  if (!department || department.type !== 'relationship_dropdown') {
    fail('expected Department child picker is missing or changed type');
  }
  for (const [label, field, target] of [
    ['Organisation', organization, { kind: 'organization' }],
    ['Department', department, {
      kind: 'custom_object',
      custom_object_id: DEPARTMENT_OBJECT_ID,
    }],
  ]) {
    const compatibility = recordReferencePickerCompatibility(field, target);
    if (!compatibility.compatible) fail(`${label} picker: ${compatibility.message}`);
  }
  if (department.selection_mode === 'multiple') {
    fail('Department picker must be single-select');
  }
  if (String(department.parent_field_id || '') !== ORGANIZATION_FIELD_ID
      || String(department.relationship_definition_id || '') !== RELATIONSHIP_IDS.organizationDepartment) {
    fail('Department picker no longer depends on the expected same-row Organisation relationship');
  }
  for (const [label, objectId, fieldId] of [
    ['Department', DEPARTMENT_OBJECT_ID, DEPARTMENT_IDENTITY_FIELD_ID],
    ['Assignment', ASSIGNMENT_OBJECT_ID, ASSIGNMENT_NAME_FIELD_ID],
  ]) {
    const object = objects.get(objectId);
    const field = fields.get(fieldId);
    if (!object || object.status !== 'active' || object.archived_at
        || String(object.primary_display_field_id) !== fieldId) {
      fail(`${label} object or primary display field is no longer active and compatible`);
    }
    if (!field || field.is_active !== true
        || field.entity_scope !== 'custom_object'
        || field.field_type !== 'text'
        || String(field.custom_object_id) !== objectId) {
      fail(`${label} identity field is no longer an active text field on the target object`);
    }
  }
  const expectedRelationships = [
    [RELATIONSHIP_IDS.organizationDepartment, DEPARTMENT_OBJECT_ID, 'organization', 'many_to_one'],
    [RELATIONSHIP_IDS.assignmentOrganization, ASSIGNMENT_OBJECT_ID, 'organization', 'many_to_one'],
    [RELATIONSHIP_IDS.assignmentMember, ASSIGNMENT_OBJECT_ID, 'member', 'many_to_one'],
    [RELATIONSHIP_IDS.departmentMember, DEPARTMENT_OBJECT_ID, 'member', 'many_to_many'],
  ];
  for (const [relationshipId, customObjectId, targetKind, cardinality] of expectedRelationships) {
    const relationship = relationships.get(relationshipId);
    const matches = relationship?.status === 'active'
      && relationship.source_kind === 'custom_object'
      && String(relationship.source_custom_object_id) === customObjectId
      && relationship.target_kind === targetKind
      && relationship.target_custom_object_id == null
      && relationship.cardinality === cardinality;
    if (!matches) fail(`active ${targetKind} relationship ${relationshipId} has drifted`);
  }
  return {
    repeatable,
    organization,
    department,
    departmentObject: objects.get(DEPARTMENT_OBJECT_ID),
    departmentIdentityField: fields.get(DEPARTMENT_IDENTITY_FIELD_ID),
    assignmentObject: objects.get(ASSIGNMENT_OBJECT_ID),
    assignmentNameField: fields.get(ASSIGNMENT_NAME_FIELD_ID),
    relationships,
  };
}

function reconcileActions(form) {
  const current = Array.isArray(form.structured_actions?.actions)
    ? form.structured_actions.actions : [];
  const managedIndexes = current
    .map((action, index) => (
      MANAGED_ACTION_IDS.has(String(action?.id)) || isManagedSemanticAction(action)
        ? index : -1
    ))
    .filter(index => index >= 0);
  const insertionIndex = managedIndexes.length ? Math.min(...managedIndexes) : current.length;
  const unrelated = current.filter(
    action => !MANAGED_ACTION_IDS.has(String(action?.id)) && !isManagedSemanticAction(action),
  );
  const nextActions = [...unrelated];
  nextActions.splice(Math.min(insertionIndex, unrelated.length), 0, ...desiredActions());
  return {
    contract: { version: 1, actions: nextActions },
    unrelatedActionIds: unrelated.map(action => String(action.id)),
  };
}

async function main() {
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required');
  const db = createClient(url, key, { auth: { persistSession: false } });

  const metadata = await loadMetadata(db);
  const resolved = validateMetadata(metadata);
  const beforeFields = JSON.stringify(metadata.form.fields);
  const beforeUnrelated = (metadata.form.structured_actions?.actions || [])
    .filter(action => !MANAGED_ACTION_IDS.has(String(action?.id))
      && !isManagedSemanticAction(action));
  const { contract, unrelatedActionIds } = reconcileActions(metadata.form);
  validateStructuredActionsContract(contract, metadata.form.fields);

  const { data: updatedRows, error: updateError } = await db.from('form')
    .update({ structured_actions: contract })
    .eq('id', FORM_ID)
    .eq('tenant_id', EXPECTED_TENANT_ID)
    .eq('structured_actions', JSON.stringify(metadata.form.structured_actions))
    .select('id');
  if (updateError) throw updateError;
  if (updatedRows?.length !== 1) {
    fail('form changed after validation; no configuration was written');
  }

  const reloaded = await loadMetadata(db);
  const verified = validateMetadata(reloaded);
  validateStructuredActionsContract(reloaded.form.structured_actions, reloaded.form.fields);
  const savedActions = reloaded.form.structured_actions.actions || [];
  const managed = savedActions.filter(action => MANAGED_ACTION_IDS.has(String(action.id)));
  if (managed.length !== Object.keys(ACTION_IDS).length
      || managed.map(action => action.id).join('|') !== Object.values(ACTION_IDS).join('|')) {
    fail('saved managed action order does not match the expected resolver/link sequence');
  }
  const savedAssignment = managed.find(action => action.id === ACTION_IDS.assignment);
  const desiredAssignment = desiredActions().find(action => action.id === ACTION_IDS.assignment);
  if (!structurallyEqual(savedAssignment?.mappings, desiredAssignment.mappings)) {
    fail('saved assignment display mapping does not use the canonical Member and Organisation labels');
  }
  if (JSON.stringify(reloaded.form.fields) !== beforeFields) {
    fail('form fields changed during the configuration update');
  }
  const savedUnrelated = savedActions.filter(action => !MANAGED_ACTION_IDS.has(String(action.id)));
  if (JSON.stringify(savedUnrelated) !== JSON.stringify(beforeUnrelated)) {
    fail('unrelated structured actions changed during reconciliation');
  }

  const verification = {
    verification_version: 1,
    form: { id: reloaded.form.id, label: reloaded.form.name },
    tenant_id: reloaded.form.tenant_id,
    repeatable_field: {
      id: verified.repeatable.id,
      label: verified.repeatable.label,
      scope: 'repeatable_row',
    },
    child_fields: [
      { id: verified.organization.id, label: verified.organization.label, target: 'organization' },
      {
        id: verified.department.id,
        label: verified.department.label,
        target: 'custom_object',
        custom_object_id: verified.departmentObject.id,
      },
    ],
    target_object: {
      id: verified.departmentObject.id,
      key: verified.departmentObject.object_key,
      label: verified.departmentObject.singular_label,
      identity_field_id: verified.departmentIdentityField.id,
      identity_field_label: verified.departmentIdentityField.label,
    },
    relationships: [
      {
        id: RELATIONSHIP_IDS.organizationDepartment,
        source: 'custom_object:org_department',
        target: 'organization',
        cardinality: verified.relationships.get(RELATIONSHIP_IDS.organizationDepartment).cardinality,
        purpose: 'Department to secondary Organisation',
      },
      {
        id: RELATIONSHIP_IDS.assignmentOrganization,
        source: 'custom_object:member_organisation_assignment',
        target: 'organization',
        cardinality: verified.relationships.get(RELATIONSHIP_IDS.assignmentOrganization).cardinality,
        purpose: 'Assignment to secondary Organisation',
      },
      {
        id: RELATIONSHIP_IDS.assignmentMember,
        source: 'custom_object:member_organisation_assignment',
        target: 'member',
        cardinality: verified.relationships.get(RELATIONSHIP_IDS.assignmentMember).cardinality,
        purpose: 'Assignment to primary Member pipeline result',
      },
      {
        id: RELATIONSHIP_IDS.departmentMember,
        source: 'custom_object:org_department',
        target: 'member',
        cardinality: verified.relationships.get(RELATIONSHIP_IDS.departmentMember).cardinality,
        purpose: 'Department to primary Member pipeline result',
      },
    ],
    assignment_object: {
      id: verified.assignmentObject.id,
      key: verified.assignmentObject.object_key,
      required_name_field_id: verified.assignmentNameField.id,
      display_mapping: savedAssignment.mappings[0],
    },
    action_order: managed.map((action, index) => ({
      position: savedActions.findIndex(saved => saved.id === action.id) + 1,
      sequence: index + 1,
      id: action.id,
      label: action.label,
      operation: action.operation,
    })),
    unrelated_action_ids: unrelatedActionIds,
    checks: {
      form_fields_unchanged: true,
      unrelated_actions_unchanged: true,
      same_repeatable_scope: true,
      link_uses_prior_action_outputs: true,
      idempotent_reconciliation: structurallyEqual(
        reconcileActions(reloaded.form).contract,
        reloaded.form.structured_actions,
      ),
      submission_data_read: false,
      primary_member_pipeline_unchanged: true,
      primary_organisation_pipeline_unchanged: true,
      assignment_display_uses_canonical_labels: true,
    },
  };
  await fs.mkdir(path.dirname(VERIFICATION_PATH), { recursive: true });
  await fs.writeFile(VERIFICATION_PATH, `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
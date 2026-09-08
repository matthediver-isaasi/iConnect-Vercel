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
const RELATIONSHIP_ID = '30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e';
const VERIFICATION_PATH = path.resolve(
  'verification/configure-additional-sites-mapping.json',
);

const ACTION_IDS = Object.freeze({
  organization: 'additional_sites_resolve_organization',
  department: 'additional_sites_resolve_department',
  relationship: 'additional_sites_link_organization_department',
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
  return action.operation === 'link_relationship'
    && String(action.relationship_definition_id || '') === RELATIONSHIP_ID;
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
      id: ACTION_IDS.relationship,
      label: 'Link additional Organisation and Department',
      source,
      operation: 'link_relationship',
      relationship_definition_id: RELATIONSHIP_ID,
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
    ).eq('tenant_id', form.tenant_id).eq('id', DEPARTMENT_OBJECT_ID),
    db.from('preference_field').select(
      'id,name,label,field_type,entity_scope,custom_object_id,is_active',
    ).eq('tenant_id', form.tenant_id).eq('id', DEPARTMENT_IDENTITY_FIELD_ID),
    db.from('custom_object_relationship_definition').select(
      'id,relationship_key,source_kind,source_custom_object_id,target_kind,target_custom_object_id,cardinality,source_label,target_label,status',
    ).eq('tenant_id', form.tenant_id).eq('id', RELATIONSHIP_ID),
  ]);
  if (objectResult.error) throw objectResult.error;
  if (fieldResult.error) throw fieldResult.error;
  if (relationshipResult.error) throw relationshipResult.error;

  return {
    form,
    object: requireSingle(objectResult.data, 'Department object'),
    identityField: requireSingle(fieldResult.data, 'Department identity field'),
    relationship: requireSingle(relationshipResult.data, 'Organisation/Department relationship'),
  };
}

function validateMetadata({ form, object, identityField, relationship }) {
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
      || String(department.relationship_definition_id || '') !== RELATIONSHIP_ID) {
    fail('Department picker no longer depends on the expected same-row Organisation relationship');
  }
  if (object.status !== 'active' || object.archived_at
      || String(object.primary_display_field_id) !== DEPARTMENT_IDENTITY_FIELD_ID) {
    fail('Department object or primary display field is no longer active and compatible');
  }
  if (identityField.is_active !== true
      || identityField.entity_scope !== 'custom_object'
      || identityField.field_type !== 'text'
      || String(identityField.custom_object_id) !== DEPARTMENT_OBJECT_ID) {
    fail('Department identity field is no longer an active text field on the target object');
  }
  const relationshipMatches = relationship.status === 'active'
    && relationship.cardinality === 'many_to_one'
    && relationship.source_kind === 'custom_object'
    && String(relationship.source_custom_object_id) === DEPARTMENT_OBJECT_ID
    && relationship.target_kind === 'organization'
    && relationship.target_custom_object_id == null;
  if (!relationshipMatches) {
    fail('active relationship endpoints or cardinality have drifted');
  }
  return { repeatable, organization, department };
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
  if (managed.length !== 3
      || managed.map(action => action.id).join('|') !== Object.values(ACTION_IDS).join('|')) {
    fail('saved managed action order does not match the expected resolver/link sequence');
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
        custom_object_id: reloaded.object.id,
      },
    ],
    target_object: {
      id: reloaded.object.id,
      key: reloaded.object.object_key,
      label: reloaded.object.singular_label,
      identity_field_id: reloaded.identityField.id,
      identity_field_label: reloaded.identityField.label,
    },
    relationship: {
      id: reloaded.relationship.id,
      key: reloaded.relationship.relationship_key,
      source: 'custom_object:org_department',
      target: 'organization',
      cardinality: reloaded.relationship.cardinality,
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
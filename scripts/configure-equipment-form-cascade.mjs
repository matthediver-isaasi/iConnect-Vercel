#!/usr/bin/env node
/**
 * Configure the pinned Equipment row-source cascade on the BNMS workforce
 * survey.  This is deliberately dry-run-first; the database write is only
 * reachable with --apply.
 *
 * The script validates the saved form, catalogue metadata, relationship
 * topology, and candidate options before changing anything.  It never reads
 * form submissions (only their count) and never creates a submission.
 *
 * Usage:
 *   node scripts/configure-equipment-form-cascade.mjs
 *   node scripts/configure-equipment-form-cascade.mjs --apply
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createFormRelationshipService } from '../api/_lib/formRelationshipOptions.js';
import { validateFormRowSourceConfiguration } from '../api/_lib/formRowSourceConfiguration.js';
import { validateRepeatableRowSubmission } from '../api/_lib/formRepeatableRowValidation.js';
import { rowSourceDependencyIds } from '../shared/formCustomObjectRowSources.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORM_ID = '8b6f44d3-83f8-449e-9496-b10b1dc28e5f';
const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const CONTAINER_ID = 'field_1789479861104';
const TYPE_FIELD_ID = 'row_field_1789479870791_pzi5h';
const MANUFACTURER_FIELD_ID = 'row_field_1789479894031_n8x01';
const MODEL_FIELD_ID = 'row_field_1789480125994_5lfxm';
const TYPE_OBJECT_ID = '3dae6022-c7e3-4ca9-b9d8-3676cb0e2173';
const TYPE_DISPLAY_FIELD_ID = 'b8f21759-ec01-4e7c-81a7-ea122499e66f';
const MODEL_OBJECT_ID = '633d90fa-aa52-4d1b-9a1d-ffd0e6e9c42a';
const MODEL_DISPLAY_FIELD_ID = '4339b11e-e53e-44be-b7c2-cbd9279e3257';
const MANUFACTURER_VALUE_FIELD_ID = 'b58e5c2f-9b2e-4c19-b54c-c382f732af59';
const RELATIONSHIP_ID = '0d97b25e-8536-469d-982c-8fd2d6908830';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHILD_IDS = [TYPE_FIELD_ID, MANUFACTURER_FIELD_ID, MODEL_FIELD_ID];
const APPLY = process.argv.includes('--apply');
const args = process.argv.slice(2);

if (args.some(arg => arg !== '--apply')) {
  throw new Error('Only --apply is supported; omit it for a read-only dry run.');
}

function fail(message) {
  throw new Error(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function checked(value, message) {
  assert.ok(value, message);
  return value;
}

function optionSource(field, message) {
  return checked(field?.option_source, message);
}

function assertSourceKeys(source, expectedKeys, message) {
  assert.deepEqual(
    Object.keys(source).sort(),
    [...expectedKeys].sort(),
    `${message} has unexpected source metadata`,
  );
}

function assertRelationshipMetadata(field, message) {
  assert.equal(field.parent_field_id, TYPE_FIELD_ID, `${message} parent field drifted`);
  if (own(field, 'parent_field_scope')) {
    assert.equal(field.parent_field_scope, 'row', `${message} parent scope drifted`);
  }
  assert.equal(field.relationship_definition_id, RELATIONSHIP_ID, `${message} relationship drifted`);
  assert.equal(field.relationship_parent_side, 'target', `${message} relationship parent side drifted`);
  assert.equal(field.relationship_parent_kind, 'custom_object', `${message} relationship parent kind drifted`);
  assert.equal(
    field.relationship_parent_custom_object_id,
    TYPE_OBJECT_ID,
    `${message} relationship parent object drifted`,
  );
  assert.equal(field.related_kind, 'custom_object', `${message} related kind drifted`);
  assert.equal(field.related_custom_object_id, MODEL_OBJECT_ID, `${message} related object drifted`);
  assert.equal(
    field.related_primary_display_field_id,
    MODEL_DISPLAY_FIELD_ID,
    `${message} related display field drifted`,
  );
}

function clone(value) {
  return structuredClone(value);
}

function findEquipmentChildren(form) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const containers = fields.filter(field => field?.id === CONTAINER_ID);
  assert.equal(containers.length, 1, `Expected exactly one Equipment container ${CONTAINER_ID}`);
  const container = containers[0];
  check(
    container.type === 'repeatable_rows',
    `Equipment container ${CONTAINER_ID} is not a repeatable_rows field`,
  );
  check(
    Array.isArray(container.child_fields),
    `Equipment container ${CONTAINER_ID} must use its child_fields array`,
  );
  assert.deepEqual(
    container.child_fields.map(child => child?.id),
    CHILD_IDS,
    'Equipment child order or identities drifted; refusing conversion',
  );
  return { container, children: container.child_fields };
}

function verifySavedChildSources(children) {
  const type = children[0];
  const manufacturer = children[1];
  const model = children[2];
  assert.equal(type.type, 'relationship_dropdown', 'Equipment Type child type drifted');
  assert.equal(manufacturer.type, 'relationship_dropdown', 'Manufacturer child type drifted');
  assert.equal(model.type, 'relationship_dropdown', 'Model child type drifted');

  const typeSource = optionSource(type, 'Equipment Type source is missing');
  assertSourceKeys(
    typeSource,
    new Set(['version', 'kind', 'custom_object_id', 'primary_display_field_id', 'filters']),
    'Equipment Type source',
  );
  assert.deepEqual(typeSource, {
    version: 1,
    kind: 'records',
    custom_object_id: TYPE_OBJECT_ID,
    primary_display_field_id: TYPE_DISPLAY_FIELD_ID,
    filters: [],
  }, 'Equipment Type source is not the pinned records source');

  const manufacturerSource = optionSource(manufacturer, 'Manufacturer source is missing');
  assertSourceKeys(
    manufacturerSource,
    new Set([
      'version', 'kind', 'custom_object_id', 'primary_display_field_id',
      'value_field_id', 'filters',
    ]),
    'Manufacturer source',
  );
  assert.deepEqual(manufacturerSource, {
    version: 1,
    kind: 'distinct',
    custom_object_id: MODEL_OBJECT_ID,
    primary_display_field_id: MODEL_DISPLAY_FIELD_ID,
    value_field_id: MANUFACTURER_VALUE_FIELD_ID,
    filters: [],
  }, 'Manufacturer source is not the pinned distinct Manufacturer source');
  assertRelationshipMetadata(manufacturer, 'Manufacturer');

  const modelSource = optionSource(model, 'Model source is missing');
  assert.equal(modelSource.version, 1, 'Model source version drifted');
  assert.equal(modelSource.custom_object_id, MODEL_OBJECT_ID, 'Model source object drifted');
  assert.equal(
    modelSource.primary_display_field_id,
    MODEL_DISPLAY_FIELD_ID,
    'Model source display field drifted',
  );
  assertRelationshipMetadata(model, 'Model');

  // A known pre-fix state is safe to convert: the Model source is a distinct
  // source over its own display field.  Any other source drift is destructive
  // and must stop rather than being silently replaced.
  if (modelSource.kind === 'distinct') {
    assertSourceKeys(
      modelSource,
      new Set([
        'version', 'kind', 'custom_object_id', 'primary_display_field_id',
        'value_field_id', 'filters',
      ]),
      'Model source',
    );
    assert.equal(
      modelSource.value_field_id,
      MODEL_DISPLAY_FIELD_ID,
      'Model distinct source is not the known model-name configuration; refusing conversion',
    );
    assert.deepEqual(modelSource.filters, [], 'Model source has unexpected existing filters');
  } else if (modelSource.kind === 'records') {
    assertSourceKeys(
      modelSource,
      new Set(['version', 'kind', 'custom_object_id', 'primary_display_field_id', 'filters']),
      'Model source',
    );
    assert.deepEqual(modelSource.filters, [{
      field_id: MANUFACTURER_VALUE_FIELD_ID,
      source_field_id: MANUFACTURER_FIELD_ID,
    }], 'Model records source already exists but has unexpected filters');
  } else {
    fail(`Model source kind ${String(modelSource.kind)} is not a supported conversion state`);
  }
}

function desiredFields(form) {
  const next = clone(form.fields);
  const { container } = findEquipmentChildren({ ...form, fields: next });
  const children = container.child_fields;
  const type = children[0];
  const manufacturer = children[1];
  const model = children[2];

  type.label = 'Equipment Type';
  manufacturer.label = 'Manufacturer';
  model.label = 'Model';

  const { value_field_id: _removedValueFieldId, ...modelSourceWithoutValueField } = model.option_source;
  model.option_source = {
    ...modelSourceWithoutValueField,
    kind: 'records',
    filters: [{
      field_id: MANUFACTURER_VALUE_FIELD_ID,
      source_field_id: MANUFACTURER_FIELD_ID,
    }],
  };
  return next;
}

async function queryData(query, message) {
  const { data, error } = await query;
  if (error) fail(`${message}: ${error.message || error}`);
  return data;
}

async function loadForm(db) {
  const form = await queryData(
    db.from('form').select('*').eq('id', FORM_ID).eq('tenant_id', TENANT_ID).maybeSingle(),
    'Failed to load pinned form',
  );
  check(form, `Form ${FORM_ID} was not found for the pinned tenant`);
  assert.equal(form.id, FORM_ID, 'Loaded form identity drifted');
  assert.equal(form.tenant_id, TENANT_ID, 'Loaded form tenant drifted');
  return form;
}

async function verifyFormSafety(db, form) {
  assert.equal(form.form_type, 'survey', 'Pinned form is no longer a survey');
  assert.equal(form.survey_settings?.status, 'draft', 'Pinned survey is not draft');
  assert.equal(form.submission_count, 0, 'Pinned form submission_count is not zero');

  const submissionCountQuery = db.from('form_submission')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', TENANT_ID)
    .eq('form_id', FORM_ID);
  const { count, error } = await submissionCountQuery;
  if (error) fail(`Failed to count pinned form submissions: ${error.message || error}`);
  assert.equal(count, 0, 'Pinned form has submissions; refusing conversion');

  assert.ok(Array.isArray(form.field_mappings), 'Pinned form field_mappings is not an array');
  assert.equal(form.field_mappings.length, 0, 'Pinned form has field mappings; refusing conversion');
  assert.ok(form.structured_actions && typeof form.structured_actions === 'object',
    'Pinned form structured_actions is missing');
  assert.ok(Array.isArray(form.structured_actions.actions),
    'Pinned form structured_actions.actions is not an array');
  assert.equal(form.structured_actions.actions.length, 0,
    'Pinned form has structured actions; refusing conversion');
  assert.ok(form.entity_pipelines && typeof form.entity_pipelines === 'object',
    'Pinned form entity_pipelines is missing');
  for (const key of ['members', 'organisations']) {
    assert.ok(Array.isArray(form.entity_pipelines[key]),
      `Pinned form entity_pipelines.${key} is not an array`);
    assert.equal(form.entity_pipelines[key].length, 0,
      `Pinned form entity_pipelines.${key} is not empty; refusing conversion`);
  }
  return { submissionCount: count };
}

async function loadAndVerifyMetadata(db) {
  const objects = await queryData(
    db.from('custom_object_definition')
      .select('id,tenant_id,primary_display_field_id,status,archived_at')
      .eq('tenant_id', TENANT_ID)
      .in('id', [TYPE_OBJECT_ID, MODEL_OBJECT_ID]),
    'Failed to load pinned equipment objects',
  );
  assert.equal(objects.length, 2, 'Pinned equipment objects are missing or duplicated');
  const typeObject = objects.find(object => object.id === TYPE_OBJECT_ID);
  const modelObject = objects.find(object => object.id === MODEL_OBJECT_ID);
  for (const [object, id, primary] of [
    [typeObject, TYPE_OBJECT_ID, TYPE_DISPLAY_FIELD_ID],
    [modelObject, MODEL_OBJECT_ID, MODEL_DISPLAY_FIELD_ID],
  ]) {
    check(object, `Pinned object ${id} is missing`);
    assert.equal(object.tenant_id, TENANT_ID, `Pinned object ${id} tenant drifted`);
    assert.equal(object.status, 'active', `Pinned object ${id} is not active`);
    assert.equal(object.archived_at, null, `Pinned object ${id} is archived`);
    assert.equal(object.primary_display_field_id, primary,
      `Pinned object ${id} primary display field drifted`);
  }

  const fields = await queryData(
    db.from('preference_field')
      .select('id,tenant_id,custom_object_id,entity_scope,field_type,is_active')
      .eq('tenant_id', TENANT_ID)
      .in('id', [TYPE_DISPLAY_FIELD_ID, MODEL_DISPLAY_FIELD_ID, MANUFACTURER_VALUE_FIELD_ID]),
    'Failed to load pinned equipment preference fields',
  );
  assert.equal(fields.length, 3, 'Pinned preference fields are missing or duplicated');
  const fieldsById = new Map(fields.map(field => [field.id, field]));
  for (const [id, objectId] of [
    [TYPE_DISPLAY_FIELD_ID, TYPE_OBJECT_ID],
    [MODEL_DISPLAY_FIELD_ID, MODEL_OBJECT_ID],
    [MANUFACTURER_VALUE_FIELD_ID, MODEL_OBJECT_ID],
  ]) {
    const field = fieldsById.get(id);
    check(field, `Pinned preference field ${id} is missing`);
    assert.equal(field.tenant_id, TENANT_ID, `Pinned preference field ${id} tenant drifted`);
    assert.equal(field.custom_object_id, objectId,
      `Pinned preference field ${id} object drifted`);
    assert.equal(field.entity_scope, 'custom_object',
      `Pinned preference field ${id} scope drifted`);
    assert.equal(field.is_active, true, `Pinned preference field ${id} is inactive`);
    assert.equal(field.field_type, 'text', `Pinned preference field ${id} is not text`);
  }

  const relationship = await queryData(
    db.from('custom_object_relationship_definition')
      .select([
        'id', 'tenant_id', 'source_kind', 'source_custom_object_id',
        'target_kind', 'target_custom_object_id', 'status', 'archived_at',
        'show_on_source', 'show_on_target',
      ].join(','))
      .eq('tenant_id', TENANT_ID)
      .eq('id', RELATIONSHIP_ID)
      .maybeSingle(),
    'Failed to load pinned equipment relationship',
  );
  check(relationship, `Pinned relationship ${RELATIONSHIP_ID} is missing`);
  assert.equal(relationship.tenant_id, TENANT_ID, 'Pinned relationship tenant drifted');
  assert.equal(relationship.status, 'active', 'Pinned relationship is not active');
  assert.equal(relationship.archived_at, null, 'Pinned relationship is archived');
  assert.equal(relationship.source_kind, 'custom_object', 'Pinned relationship source kind drifted');
  assert.equal(relationship.source_custom_object_id, MODEL_OBJECT_ID,
    'Pinned relationship source object drifted');
  assert.equal(relationship.target_kind, 'custom_object', 'Pinned relationship target kind drifted');
  assert.equal(relationship.target_custom_object_id, TYPE_OBJECT_ID,
    'Pinned relationship target object drifted');
  assert.notEqual(relationship.show_on_target, false,
    'Pinned relationship is hidden on the Type target');
  assert.notEqual(relationship.show_on_source, false,
    'Pinned relationship is hidden on the Model source');
  return { typeObject, modelObject, fieldsById, relationship };
}

async function activeRecordCount(db, objectId) {
  const { count, error } = await db.from('custom_object_record')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', TENANT_ID)
    .eq('custom_object_id', objectId)
    .is('archived_at', null);
  if (error) fail(`Failed to count active records for ${objectId}: ${error.message || error}`);
  return count;
}

async function optionsFor(service, form, fieldId, dependencyAnswers = {}) {
  const result = [];
  for (let page = 1; ; page += 1) {
    const payload = await service.relationshipOptions({
      form,
      rootForm: form,
      containerFieldId: CONTAINER_ID,
      fieldId,
      dependencyAnswers,
      query: { page, pageSize: 100 },
    });
    assert.ok(Array.isArray(payload.data), `Options for ${fieldId} did not return data`);
    assert.ok(payload.data.every(option => (
      option && Object.keys(option).sort().join(',') === 'id,label'
    )), `Options for ${fieldId} returned unexpected option metadata`);
    result.push(...payload.data);
    if (result.length >= payload.total) return result;
    assert.ok(payload.data.length, `Options for ${fieldId} stopped before total`);
  }
}

async function verifyCandidateOptions(db, form) {
  const service = createFormRelationshipService({ db, tenantId: TENANT_ID });
  const container = findEquipmentChildren(form).container;
  const children = container.child_fields;
  const validation = await validateFormRowSourceConfiguration({
    db,
    tenantId: TENANT_ID,
    form,
    relationshipService: service,
  });
  assert.deepEqual(validation, { ok: true }, 'Candidate row-source configuration was rejected');

  // Exercise the actual saved-form resolver for all three columns.  Counts
  // are retained for the report; no option labels or catalogue answers are
  // printed.
  const typeOptions = await optionsFor(service, form, TYPE_FIELD_ID);
  const expectedTypeCount = await activeRecordCount(db, TYPE_OBJECT_ID);
  assert.equal(typeOptions.length, expectedTypeCount,
    'Equipment Type options do not equal active Type records');
  assert.ok(typeOptions.length > 0, 'No active Equipment Type options were returned');
  assert.ok(typeOptions.every(option => UUID_RE.test(option.id)),
    'Equipment Type options do not preserve record IDs');

  const perType = [];
  let representative = null;
  let totalManufacturerOptions = 0;
  let totalModelOptions = 0;
  for (const typeOption of typeOptions) {
    const manufacturerOptions = await optionsFor(service, form, MANUFACTURER_FIELD_ID, {
      [TYPE_FIELD_ID]: typeOption.id,
    });
    assert.equal(
      new Set(manufacturerOptions.map(option => option.id)).size,
      manufacturerOptions.length,
      'Manufacturer options are not distinct',
    );
    assert.ok(
      manufacturerOptions.every(option => typeof option.id === 'string'
        && option.id.trim() && option.id === option.label),
      'Manufacturer options do not preserve scalar text values',
    );
    totalManufacturerOptions += manufacturerOptions.length;
    let modelsForType = 0;
    for (const manufacturerOption of manufacturerOptions) {
      const modelOptions = await optionsFor(service, form, MODEL_FIELD_ID, {
        [TYPE_FIELD_ID]: typeOption.id,
        [MANUFACTURER_FIELD_ID]: manufacturerOption.id,
      });
      assert.ok(modelOptions.every(option => UUID_RE.test(option.id)),
        'Model options do not preserve record IDs');
      assert.ok(modelOptions.length > 0,
        'A returned Manufacturer option has no eligible Model records');
      modelsForType += modelOptions.length;
      totalModelOptions += modelOptions.length;
      representative ||= {
        [TYPE_FIELD_ID]: typeOption.id,
        [MANUFACTURER_FIELD_ID]: manufacturerOption.id,
        [MODEL_FIELD_ID]: modelOptions[0].id,
      };
    }
    assert.ok(manufacturerOptions.length > 0,
      'An active Equipment Type has no eligible Manufacturer options');
    perType.push({
      typeId: typeOption.id,
      manufacturerOptions: manufacturerOptions.length,
      modelOptions: modelsForType,
    });
  }
  check(representative, 'No complete Equipment Type/Manufacturer/Model option exists');

  // An unknown scalar upstream value must not leak Model options.  This is
  // also a read-only negative test for the row dependency boundary.
  const forgedDependencyOptions = await optionsFor(service, form, MODEL_FIELD_ID, {
    [TYPE_FIELD_ID]: typeOptions[0].id,
    [MANUFACTURER_FIELD_ID]: '__forged_manufacturer__',
  });
  assert.equal(forgedDependencyOptions.length, 0,
    'Forged Manufacturer dependency returned Model options');

  await validateRepeatableRowSubmission({
    db,
    tenantId: TENANT_ID,
    form,
    submissionData: {
      [CONTAINER_ID]: [{ _row_id: 'equipment-cascade-verification', ...representative }],
    },
  });
  await assert.rejects(
    validateRepeatableRowSubmission({
      db,
      tenantId: TENANT_ID,
      form,
      submissionData: {
        [CONTAINER_ID]: [{
          _row_id: 'equipment-cascade-forged-verification',
          ...representative,
          [MANUFACTURER_FIELD_ID]: '__forged_manufacturer__',
        }],
      },
    }),
    'A forged Manufacturer scalar was accepted',
  );

  // Keep the dependency declaration under test as well; this catches a
  // candidate that happens to resolve options but no longer describes the
  // intended row-local cascade.
  assert.deepEqual(rowSourceDependencyIds(children[0]), [], 'Type has unexpected dependencies');
  assert.deepEqual(rowSourceDependencyIds(children[1]), [TYPE_FIELD_ID],
    'Manufacturer dependency drifted');
  assert.deepEqual(rowSourceDependencyIds(children[2]), [TYPE_FIELD_ID, MANUFACTURER_FIELD_ID],
    'Model dependencies drifted');
  return {
    typeOptions: typeOptions.length,
    activeTypeRecords: expectedTypeCount,
    perType,
    manufacturerOptions: totalManufacturerOptions,
    modelOptions: totalModelOptions,
    forgedDependencyOptions: forgedDependencyOptions.length,
    validRowAccepted: true,
    forgedManufacturerRejected: true,
  };
}

function fieldsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertOnlyExpectedFieldChanges(before, after, expected) {
  assert.deepEqual(after, expected, 'Saved form fields differ from the exact candidate patch');
  const beforeContainer = findEquipmentChildren({ fields: before }).container;
  const afterContainer = findEquipmentChildren({ fields: after }).container;
  const expectedContainer = findEquipmentChildren({ fields: expected }).container;
  const beforeById = new Map(beforeContainer.child_fields.map(child => [child.id, child]));
  const afterById = new Map(afterContainer.child_fields.map(child => [child.id, child]));
  const expectedById = new Map(expectedContainer.child_fields.map(child => [child.id, child]));
  for (const id of CHILD_IDS) {
    const beforeChild = beforeById.get(id);
    const afterChild = afterById.get(id);
    const expectedChild = expectedById.get(id);
    if (id === TYPE_FIELD_ID || id === MANUFACTURER_FIELD_ID) {
      const beforeWithoutLabel = { ...beforeChild };
      const afterWithoutLabel = { ...afterChild };
      delete beforeWithoutLabel.label;
      delete afterWithoutLabel.label;
      assert.deepEqual(afterWithoutLabel, beforeWithoutLabel,
        `${id} changed outside its label`);
    } else {
      const beforeWithoutManagedSource = { ...beforeChild };
      const afterWithoutManagedSource = { ...afterChild };
      delete beforeWithoutManagedSource.label;
      delete afterWithoutManagedSource.label;
      delete beforeWithoutManagedSource.option_source;
      delete afterWithoutManagedSource.option_source;
      assert.deepEqual(afterWithoutManagedSource, beforeWithoutManagedSource,
        `${id} changed outside its label and option_source`);
    }
    assert.deepEqual(afterChild, expectedChild, `${id} does not match candidate`);
  }
}

function assertNonFieldsUnchanged(before, after) {
  const beforeWithoutFields = { ...before };
  const afterWithoutFields = { ...after };
  delete beforeWithoutFields.fields;
  delete afterWithoutFields.fields;
  delete beforeWithoutFields.updated_at;
  delete afterWithoutFields.updated_at;
  assert.deepEqual(afterWithoutFields, beforeWithoutFields,
    'A non-fields form configuration changed during the update');
}

async function applyCandidate(db, form, candidate) {
  check(
    own(form, 'updated_at'),
    'Cannot apply safely: the destination form has no updated_at column, but CAS requires fields + updated_at',
  );
  const backupDirectory = path.join(ROOT, '.local', 'backups');
  await mkdir(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(
    backupDirectory,
    `configure-equipment-form-cascade-${FORM_ID}-${timestamp}.json`,
  );
  await writeFile(backupPath, `${JSON.stringify({
    snapshot_version: 1,
    captured_at: new Date().toISOString(),
    form,
  }, null, 2)}\n`, 'utf8');

  const now = new Date().toISOString();
  let update = db.from('form')
    .update({ fields: candidate.fields, updated_at: now })
    .eq('id', FORM_ID)
    .eq('tenant_id', TENANT_ID)
    .eq('fields', JSON.stringify(form.fields))
    .eq('updated_at', form.updated_at)
    .select('id,fields,updated_at');
  const { data, error } = await update.maybeSingle();
  if (error) fail(`CAS form update failed: ${error.message || error}`);
  check(data, 'CAS lost a concurrent form update; no configuration was written');
  assert.equal(data.id, FORM_ID, 'CAS update returned the wrong form');
  return { backupPath, updatedAt: data.updated_at };
}

async function main() {
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  check(url && key, 'DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required');
  const db = createClient(url, key, { auth: { persistSession: false } });

  const form = await loadForm(db);
  const safety = await verifyFormSafety(db, form);
  const metadata = await loadAndVerifyMetadata(db);
  const { children } = findEquipmentChildren(form);
  verifySavedChildSources(children);
  const candidate = { ...form, fields: desiredFields(form) };
  assertOnlyExpectedFieldChanges(form.fields, candidate.fields, candidate.fields);

  const options = await verifyCandidateOptions(db, candidate);
  const changed = !fieldsEqual(form.fields, candidate.fields);
  const casReady = own(form, 'updated_at');
  const report = {
    dryRun: !APPLY,
    applyRequested: APPLY,
    formId: FORM_ID,
    tenantId: TENANT_ID,
    survey: {
      formType: form.form_type,
      status: form.survey_settings.status,
      declaredSubmissions: form.submission_count,
      actualSubmissions: safety.submissionCount,
      fieldMappings: form.field_mappings.length,
      structuredActions: form.structured_actions.actions.length,
      entityPipelineMembers: form.entity_pipelines.members.length,
      entityPipelineOrganisations: form.entity_pipelines.organisations.length,
    },
    verified: {
      typeObject: metadata.typeObject.id,
      modelObject: metadata.modelObject.id,
      relationship: metadata.relationship.id,
      preferenceFields: [TYPE_DISPLAY_FIELD_ID, MODEL_DISPLAY_FIELD_ID, MANUFACTURER_VALUE_FIELD_ID],
      container: CONTAINER_ID,
      children: CHILD_IDS,
    },
    candidateOptions: options,
    changes: {
      labels: ['Equipment Type', 'Manufacturer', 'Model'],
      modelSource: changed ? 'records + Manufacturer equality filter' : 'already configured',
      fieldsChanged: changed,
      casFields: true,
      casUpdatedAt: casReady,
    },
  };

  if (!APPLY) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!changed) {
    report.noOp = true;
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const applied = await applyCandidate(db, form, candidate);
  const reloaded = await loadForm(db);
  assertNonFieldsUnchanged(form, reloaded);
  assertOnlyExpectedFieldChanges(form.fields, reloaded.fields, candidate.fields);
  const postOptions = await verifyCandidateOptions(db, reloaded);
  report.noOp = false;
  report.backupPath = path.relative(ROOT, applied.backupPath);
  report.updatedAt = applied.updatedAt;
  report.postReloadOptions = postOptions;
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(`configure-equipment-form-cascade: ${error.message || error}`);
  process.exitCode = 1;
});
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEPARTMENT_COUNT, DEPARTMENT_OBJECT_ID, EXPECTED_SHA256, FILE,
  HEADERS, IDENTICAL_DUPLICATE_COUNT, OBJECT_KEYS, RELATIONSHIP_KEYS,
  ROW_COUNT, TENANT_ID, TYPE_COUNT, auditLiveContract, effectiveManufacturer,
  canResumeImporterPresentation, equipmentData, makePlan, modelIdentity, parseCsvBytes,
} from './import-bnms-equipment-register.mjs';

const source = () => parseCsvBytes(readFileSync(FILE));

function fixture() {
  const input = source();
  const departmentObject = {
    id: DEPARTMENT_OBJECT_ID, tenant_id: TENANT_ID, object_key: 'org_department',
    status: 'active', archived_at: null,
  };
  const objects = [
    departmentObject,
    { id: 'equipment', tenant_id: TENANT_ID, object_key: OBJECT_KEYS.equipment, singular_label: 'Equipment Register', plural_label: 'Equipment Register', status: 'active', archived_at: null },
    { id: 'type', tenant_id: TENANT_ID, object_key: OBJECT_KEYS.type, singular_label: 'Equipment Type', plural_label: 'Equipment Types', status: 'active', archived_at: null },
    { id: 'model', tenant_id: TENANT_ID, object_key: OBJECT_KEYS.model, singular_label: 'Model', plural_label: 'Models', status: 'active', archived_at: null },
  ];
  const contracts = {
    equipment: [
      ['item_name', 'Equipment item', 'text', true],
      ['source_identity', 'Source row identity', 'text', true],
      ['manufacturer_raw', 'Manufacturer (source)', 'text', false],
      ['other_manufacturer_raw', 'Other manufacturer (source)', 'text', false],
      ['model_raw', 'Model (source)', 'text', false],
      ['year_installed', 'Year installed', 'number', false],
      ['still_in_service', 'Still in service', 'dropdown', false],
      ['year_decommissioned', 'Year decommissioned', 'number', false],
      ['additional_information', 'Additional information', 'textarea', false],
    ],
    type: [['name', 'Name', 'text', true]],
    model: [['name', 'Model', 'text', true], ['manufacturer', 'Manufacturer', 'text', false], ['source_identity', 'Reference identity', 'text', true]],
  };
  const fields = Object.entries(contracts).flatMap(([kind, rows]) => rows.map(([name, label, field_type, is_required], index) => ({
    id: `${kind}-${name}`, tenant_id: TENANT_ID, custom_object_id: kind,
    entity_scope: 'custom_object', name, label, field_type, is_required,
    is_active: true, display_order: index,
    ...(name === 'still_in_service' ? { options: ['Yes', 'No'].map((value) => ({ label: value, value })) } : {}),
  })));
  for (const kind of ['equipment', 'type', 'model']) objects.find((item) => item.id === kind).primary_display_field_id = fields.find((field) => field.custom_object_id === kind).id;
  const rel = (id, sourceId, targetId, required) => ({
    id, tenant_id: TENANT_ID, relationship_key: RELATIONSHIP_KEYS[id],
    source_kind: 'custom_object', target_kind: 'custom_object',
    source_custom_object_id: sourceId, target_custom_object_id: targetId,
    cardinality: 'many_to_one', is_required: required, status: 'active',
    show_on_source: true, show_on_target: true, edit_from_source: true, edit_from_target: true,
  });
  const relationships = [
    rel('department', 'equipment', DEPARTMENT_OBJECT_ID, true),
    rel('type', 'equipment', 'type', true),
    rel('model', 'equipment', 'model', false),
    rel('modelType', 'model', 'type', true),
  ];
  const departments = input.departmentIds.map((id) => ({
    id, tenant_id: TENANT_ID, custom_object_id: DEPARTMENT_OBJECT_ID, archived_at: null,
  }));
  return {
    source: input,
    state: {
      tenant: { id: TENANT_ID, name: 'BNMS' }, departmentObject, objects, fields,
      relationships, departments, records: [], edges: [],
    },
  };
}

test('pinned CSV preserves the exact cardinality, Departments, types, and duplicate physical rows', () => {
  const input = source();
  assert.equal(input.fingerprint, EXPECTED_SHA256);
  assert.equal(input.rows.length, ROW_COUNT);
  assert.equal(input.departmentIds.length, DEPARTMENT_COUNT);
  assert.equal(input.types.length, TYPE_COUNT);
  assert.equal(input.duplicateCount, IDENTICAL_DUPLICATE_COUNT);
  assert.equal(new Set(input.rows.map((row) => row.sourceIdentity)).size, ROW_COUNT);
});

test('file and header drift fail closed', () => {
  const bytes = readFileSync(FILE);
  assert.throws(() => parseCsvBytes(Buffer.concat([bytes, Buffer.from('x')])), /fingerprint mismatch/);
  const changed = Buffer.from(bytes.toString().replace(HEADERS[0], 'Wrong_Header'));
  assert.throws(() => parseCsvBytes(changed, { verifyFingerprint: false }), /exact 9-column header/);
});

test('Other manufacturer resolution and blank values are explicit and non-destructive', () => {
  const input = source();
  const other = input.rows.find((row) => row.manufacturer === 'Other' && row.otherManufacturer);
  assert.equal(effectiveManufacturer(other), other.otherManufacturer);
  const unresolvedOther = input.rows.find((row) => row.manufacturer === 'Other' && !row.otherManufacturer);
  assert.equal(effectiveManufacturer(unresolvedOther), 'Other');
  const blankModel = input.rows.find((row) => !row.model);
  assert.equal(modelIdentity(blankModel), null);
  const data = equipmentData(blankModel);
  assert.equal(data.model_raw, '');
  assert.equal(data.manufacturer_raw, blankModel.manufacturer);
  assert.equal(data.additional_information, blankModel.additionalInformation);
});

test('nullable lifecycle values remain blank instead of becoming zero', () => {
  const row = source().rows.find((item) => item.yearInstalled === null && item.yearDecommissioned === null);
  const data = equipmentData(row);
  assert.equal(Object.hasOwn(data, 'year_installed'), false);
  assert.equal(Object.hasOwn(data, 'year_decommissioned'), false);
  assert.equal(data.still_in_service, row.stillInService);
});

test('valid live metadata and all Departments produce a complete create plan', () => {
  const { source: input, state } = fixture();
  const contract = auditLiveContract(input, state);
  assert.deepEqual(contract.blockers, []);
  const plan = makePlan(input, state, contract);
  assert.equal(plan.types.length, TYPE_COUNT);
  assert.equal(plan.equipment.length, ROW_COUNT);
  assert.ok(plan.types.every((item) => item.action === 'create'));
  assert.ok(plan.models.every((item) => item.action === 'create'));
  assert.ok(plan.equipment.every((item) => item.action === 'create'));
});

test('cross-tenant Departments and metadata drift block all writes', () => {
  const { source: input, state } = fixture();
  state.departments[0].tenant_id = '00000000-0000-4000-8000-000000000000';
  state.fields.find((field) => field.name === 'still_in_service').options = [];
  state.relationships.find((item) => item.id === 'model').is_required = true;
  const contract = auditLiveContract(input, state);
  assert.ok(contract.blockers.some((item) => item.includes('cross-tenant')));
  assert.ok(contract.blockers.some((item) => item.includes('options drifted')));
  assert.ok(contract.blockers.some((item) => item.includes(RELATIONSHIP_KEYS.model)));
  assert.equal(makePlan(input, state, contract).blocked, true);
});

test('reference records reuse exact type and model identities without spelling merges', () => {
  const { source: input, state } = fixture();
  const contract = auditLiveContract(input, state);
  const firstType = input.types[0];
  const firstModelRow = input.rows.find((row) => row.model);
  state.records.push(
    { id: 'type-existing', custom_object_id: 'type', archived_at: null, data: { name: firstType } },
    { id: 'model-existing', custom_object_id: 'model', archived_at: null, data: {
      name: firstModelRow.model, manufacturer: effectiveManufacturer(firstModelRow),
      source_identity: modelIdentity(firstModelRow),
    } },
  );
  state.edges.push({
    id: 'model-type-existing', source_record_id: 'model-existing',
    target_record_id: 'type-existing', relationship_definition_id: 'modelType', archived_at: null,
  });
  const plan = makePlan(input, state, contract);
  assert.equal(plan.types.find((item) => item.name === firstType).action, 'reuse');
  assert.equal(plan.models.find((item) => item.identity === modelIdentity(firstModelRow)).action, 'reuse');
});

test('all 823 ordinal identities replay as reuse, including identical source rows', () => {
  const { source: input, state } = fixture();
  const contract = auditLiveContract(input, state);
  for (const [index, name] of input.types.entries()) {
    state.records.push({ id: `type-${index}`, custom_object_id: 'type', archived_at: null, data: { name } });
  }
  const typeIds = new Map(input.types.map((name, index) => [name, `type-${index}`]));
  const modelRows = [...new Map(input.rows.filter((row) => row.model).map((row) => [modelIdentity(row), row])).values()];
  for (const [index, row] of modelRows.entries()) {
    const id = `model-${index}`;
    state.records.push({ id, custom_object_id: 'model', archived_at: null, data: {
      name: row.model, manufacturer: effectiveManufacturer(row), source_identity: modelIdentity(row),
    } });
    state.edges.push({ id: `model-type-${index}`, source_record_id: id, target_record_id: typeIds.get(row.equipmentType), relationship_definition_id: 'modelType', archived_at: null });
  }
  const modelIds = new Map(modelRows.map((row, index) => [modelIdentity(row), `model-${index}`]));
  for (const [index, row] of input.rows.entries()) {
    const id = `equipment-${index}`;
    state.records.push({ id, custom_object_id: 'equipment', archived_at: null, data: equipmentData(row) });
    state.edges.push(
      { id: `dept-${index}`, source_record_id: id, target_record_id: row.departmentId, relationship_definition_id: 'department', archived_at: null },
      { id: `type-edge-${index}`, source_record_id: id, target_record_id: typeIds.get(row.equipmentType), relationship_definition_id: 'type', archived_at: null },
      ...(row.model ? [{ id: `model-edge-${index}`, source_record_id: id, target_record_id: modelIds.get(modelIdentity(row)), relationship_definition_id: 'model', archived_at: null }] : []),
    );
  }
  const replay = makePlan(input, state, contract);
  assert.equal(replay.equipment.length, ROW_COUNT);
  assert.ok(replay.types.every((item) => item.action === 'reuse'));
  assert.ok(replay.models.every((item) => item.action === 'reuse'));
  assert.ok(replay.equipment.every((item) => item.action === 'reuse'));
});

test('ambiguous destination identity fails instead of creating more records', () => {
  const { source: input, state } = fixture();
  const contract = auditLiveContract(input, state);
  const identity = input.rows[0].sourceIdentity;
  state.records.push(
    { id: 'duplicate-a', custom_object_id: 'equipment', archived_at: null, data: { source_identity: identity } },
    { id: 'duplicate-b', custom_object_id: 'equipment', archived_at: null, data: { source_identity: identity } },
  );
  assert.throws(() => makePlan(input, state, contract), /ambiguous/);
});

test('a partial prior run resumes only after all reused references pass integrity checks', () => {
  const { source: input, state } = fixture();
  const contract = auditLiveContract(input, state);
  const row = input.rows.find((item) => item.model);
  state.records.push(
    { id: 'type-existing', custom_object_id: 'type', archived_at: null, data: { name: row.equipmentType } },
    { id: 'model-existing', custom_object_id: 'model', archived_at: null, data: {
      name: row.model, manufacturer: effectiveManufacturer(row), source_identity: modelIdentity(row),
    } },
  );
  state.edges.push({
    id: 'wrong-model-type', source_record_id: 'model-existing',
    target_record_id: 'wrong-type', relationship_definition_id: 'modelType', archived_at: null,
  });
  assert.throws(() => makePlan(input, state, contract), /wrong Equipment Type relationship/);
});

test('reused equipment must preserve every value and all expected relationships before writes', () => {
  const { source: input, state } = fixture();
  const contract = auditLiveContract(input, state);
  const row = input.rows.find((item) => !item.model);
  state.records.push(
    { id: 'type-existing', custom_object_id: 'type', archived_at: null, data: { name: row.equipmentType } },
    { id: 'equipment-existing', custom_object_id: 'equipment', archived_at: null,
      data: { ...equipmentData(row), additional_information: 'drifted' } },
  );
  state.edges.push(
    { id: 'department-edge', source_record_id: 'equipment-existing', target_record_id: row.departmentId, relationship_definition_id: 'department', archived_at: null },
    { id: 'type-edge', source_record_id: 'equipment-existing', target_record_id: 'type-existing', relationship_definition_id: 'type', archived_at: null },
  );
  assert.throws(() => makePlan(input, state, contract), /source values drifted/);
});

test('only the importer-owned relationship-free bootstrap presentation is resumable', () => {
  const fieldIds = ['field-a', 'field-b'];
  const bootstrap = {
    views: {
      list: { field_ids: fieldIds },
      detail: {
        version: 2,
        schema_field_ids: fieldIds,
        cards: [{
          id: 'card-details', title: 'Details', columns: 2,
          fields: [
            { id: 'field:field-a', type: 'field', field_id: 'field-a', columnIndex: 0 },
            { id: 'field:field-b', type: 'field', field_id: 'field-b', columnIndex: 1 },
          ],
        }],
        visibility_rules: { version: 1, rules: [] },
      },
    },
  };
  assert.equal(canResumeImporterPresentation({
    created_by: 'system:bnms-equipment-register-import', configuration: bootstrap,
  }, fieldIds), true);
  assert.equal(canResumeImporterPresentation({
    created_by: 'tenant_user', configuration: bootstrap,
  }, fieldIds), false);
  assert.equal(canResumeImporterPresentation({
    created_by: 'system:bnms-equipment-register-import',
    configuration: { ...bootstrap, custom_admin_change: true },
  }, fieldIds), false);
});
#!/usr/bin/env node
/**
 * Pinned, dry-run-first BNMS Equipment Register import.
 *
 * Usage:
 *   node scripts/import-bnms-equipment-register.mjs
 *   node scripts/import-bnms-equipment-register.mjs --apply
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'attached_assets', 'BNMS_Equipment_Import_SIMPLIFIED_05.09.26_to_import_1788722216098.csv');
export const EXPECTED_SHA256 = '0343a3bf9958874908b5df0cb5196a2198ebc4a553a06decaa2cb742c34a7502';
export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const DEPARTMENT_OBJECT_ID = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
export const ROW_COUNT = 823;
export const DEPARTMENT_COUNT = 154;
export const TYPE_COUNT = 11;
export const IDENTICAL_DUPLICATE_COUNT = 76;
export const HEADERS = Object.freeze([
  'Department_UUID', 'Equipment_Type', 'Manufacturer', 'Other_Manufacturer',
  'Model', 'Year_Installed', 'Still_In_Service', 'Year_Decommissioned',
  'Additional_Information',
]);
export const OBJECT_KEYS = Object.freeze({
  equipment: 'equipment_register',
  type: 'equipment_type',
  model: 'equipment_model',
});
export const RELATIONSHIP_KEYS = Object.freeze({
  department: 'equipment_register_department',
  type: 'equipment_register_type',
  model: 'equipment_register_model',
  modelType: 'equipment_model_type',
});
const ACTOR = 'system:bnms-equipment-register-import';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message) => { throw new Error(message); };
const check = (error, context) => { if (error) fail(`${context}: ${error.message}`); };
const text = (value) => String(value ?? '').normalize('NFKC').trim();
const nullableNumber = (value, row, label) => {
  const cleaned = text(value);
  if (!cleaned) return null;
  if (!/^\d{4}$/.test(cleaned)) fail(`CSV row ${row} has invalid ${label} "${cleaned}".`);
  return Number(cleaned);
};

export function sourceIdentity(fingerprint, ordinal) {
  return `${fingerprint}:${String(ordinal).padStart(4, '0')}`;
}

export function effectiveManufacturer(row) {
  return row.manufacturer === 'Other'
    ? (row.otherManufacturer || 'Other')
    : row.manufacturer;
}

export function modelIdentity(row) {
  if (!row.model) return null;
  return JSON.stringify([row.equipmentType, effectiveManufacturer(row), row.model]);
}

export function parseCsvBytes(bytes, { verifyFingerprint = true } = {}) {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (verifyFingerprint && fingerprint !== EXPECTED_SHA256) {
    fail(`CSV fingerprint mismatch; expected ${EXPECTED_SHA256}, found ${fingerprint}.`);
  }
  const grid = parse(bytes, { bom: true, relax_column_count: false, skip_empty_lines: false });
  if (grid.length !== ROW_COUNT + 1 || grid[0].length !== HEADERS.length
    || grid[0].some((value, index) => value !== HEADERS[index])) {
    fail(`CSV must have the exact ${HEADERS.length}-column header and ${ROW_COUNT}-row contract.`);
  }
  const rows = grid.slice(1).map((input, index) => {
    const sourceRow = index + 2;
    const ordinal = index + 1;
    if (input.length !== HEADERS.length) fail(`CSV row ${sourceRow} must have exactly ${HEADERS.length} cells.`);
    const values = input.map(text);
    if (!UUID_RE.test(values[0])) fail(`CSV row ${sourceRow} has an invalid Department UUID.`);
    if (!values[1]) fail(`CSV row ${sourceRow} has a blank Equipment Type.`);
    if (!['', 'Yes', 'No'].includes(values[6])) {
      fail(`CSV row ${sourceRow} has unsupported Still In Service value "${values[6]}".`);
    }
    return {
      sourceRow,
      ordinal,
      sourceIdentity: sourceIdentity(fingerprint, ordinal),
      departmentId: values[0],
      equipmentType: values[1],
      manufacturer: values[2],
      otherManufacturer: values[3],
      model: values[4],
      yearInstalled: nullableNumber(values[5], sourceRow, 'Year Installed'),
      stillInService: values[6],
      yearDecommissioned: nullableNumber(values[7], sourceRow, 'Year Decommissioned'),
      additionalInformation: values[8],
    };
  });
  const departmentIds = new Set(rows.map((row) => row.departmentId));
  const types = new Set(rows.map((row) => row.equipmentType));
  const duplicateCount = rows.length - new Set(rows.map((row) => JSON.stringify([
    row.departmentId, row.equipmentType, row.manufacturer, row.otherManufacturer,
    row.model, row.yearInstalled, row.stillInService, row.yearDecommissioned,
    row.additionalInformation,
  ]))).size;
  if (departmentIds.size !== DEPARTMENT_COUNT) fail(`CSV must reference ${DEPARTMENT_COUNT} distinct Departments; found ${departmentIds.size}.`);
  if (types.size !== TYPE_COUNT) fail(`CSV must contain ${TYPE_COUNT} Equipment Types; found ${types.size}.`);
  if (duplicateCount !== IDENTICAL_DUPLICATE_COUNT) {
    fail(`CSV must contain ${IDENTICAL_DUPLICATE_COUNT} source-identical duplicate rows; found ${duplicateCount}.`);
  }
  if (new Set(rows.map((row) => row.sourceIdentity)).size !== ROW_COUNT) fail('Source row identities are not unique.');
  return { fingerprint, rows, departmentIds: [...departmentIds], types: [...types], duplicateCount };
}

export const readSource = (file = FILE) => parseCsvBytes(readFileSync(file));

const FIELD_CONTRACTS = Object.freeze({
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
  model: [
    ['name', 'Model', 'text', true],
    ['manufacturer', 'Manufacturer', 'text', false],
    ['source_identity', 'Reference identity', 'text', true],
  ],
});

const OBJECT_CONTRACTS = Object.freeze({
  equipment: ['Equipment Register', 'Equipment Register', 'Physical equipment items reported by BNMS departments.', 'Database'],
  type: ['Equipment Type', 'Equipment Types', 'Reusable equipment classifications from the BNMS register.', 'Tag'],
  model: ['Model', 'Models', 'Reusable equipment models and their source manufacturer.', 'Boxes'],
});

export function equipmentData(row) {
  return {
    item_name: `Equipment item ${String(row.ordinal).padStart(4, '0')}`,
    source_identity: row.sourceIdentity,
    manufacturer_raw: row.manufacturer,
    other_manufacturer_raw: row.otherManufacturer,
    model_raw: row.model,
    ...(row.yearInstalled === null ? {} : { year_installed: row.yearInstalled }),
    still_in_service: row.stillInService,
    ...(row.yearDecommissioned === null ? {} : { year_decommissioned: row.yearDecommissioned }),
    additional_information: row.additionalInformation,
  };
}

const canonicalJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalJson(child)]));
  }
  return value;
};
const equalJson = (left, right) =>
  JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));

export function auditLiveContract(source, state, { allowMissingSchema = false } = {}) {
  const blockers = [];
  if (state.tenant?.id !== TENANT_ID || state.tenant?.name !== 'BNMS') blockers.push('Pinned tenant is not BNMS.');
  if (!state.departmentObject || state.departmentObject.id !== DEPARTMENT_OBJECT_ID
    || state.departmentObject.object_key !== 'org_department' || state.departmentObject.status !== 'active') {
    blockers.push('The pinned active BNMS Department object drifted.');
  }
  const departments = new Map(state.departments.map((record) => [record.id, record]));
  for (const id of source.departmentIds) {
    const department = departments.get(id);
    if (!department || department.tenant_id !== TENANT_ID
      || department.custom_object_id !== DEPARTMENT_OBJECT_ID || department.archived_at) {
      blockers.push(`Department ${id} is missing, archived, cross-tenant, or belongs to another object.`);
    }
  }
  const objects = {};
  const fields = {};
  for (const kind of Object.keys(OBJECT_KEYS)) {
    const matches = state.objects.filter((object) => object.object_key === OBJECT_KEYS[kind]);
    if (matches.length > 1) blockers.push(`More than one ${OBJECT_KEYS[kind]} object exists.`);
    objects[kind] = matches[0] || null;
    if (!objects[kind]) {
      if (!allowMissingSchema) blockers.push(`Missing ${OBJECT_KEYS[kind]} object.`);
      fields[kind] = {};
      continue;
    }
    const [singular, plural] = OBJECT_CONTRACTS[kind];
    if (objects[kind].tenant_id !== TENANT_ID
      || (!allowMissingSchema && objects[kind].status !== 'active')
      || (allowMissingSchema && !['draft', 'active'].includes(objects[kind].status))
      || objects[kind].archived_at || objects[kind].singular_label !== singular
      || objects[kind].plural_label !== plural) blockers.push(`${OBJECT_KEYS[kind]} object metadata drifted.`);
    fields[kind] = {};
    for (const [name, label, fieldType, required] of FIELD_CONTRACTS[kind]) {
      const matchesForField = state.fields.filter((field) =>
        field.custom_object_id === objects[kind].id && field.name === name && field.is_active);
      if (matchesForField.length !== 1) {
        if (!allowMissingSchema || matchesForField.length > 1) {
          blockers.push(`${OBJECT_KEYS[kind]}.${name} must resolve exactly once; found ${matchesForField.length}.`);
        }
        continue;
      }
      const field = matchesForField[0];
      fields[kind][name] = field;
      if (field.label !== label || field.field_type !== fieldType || field.is_required !== required) {
        blockers.push(`${OBJECT_KEYS[kind]}.${name} metadata drifted.`);
      }
      if (name === 'still_in_service') {
        const values = (field.options || []).map((option) => option.value);
        if (JSON.stringify(values) !== JSON.stringify(['Yes', 'No'])) blockers.push('Still in service options drifted.');
      }
    }
    if (!allowMissingSchema && fields[kind][FIELD_CONTRACTS[kind][0][0]]
      && objects[kind].primary_display_field_id !== fields[kind][FIELD_CONTRACTS[kind][0][0]].id) {
      blockers.push(`${OBJECT_KEYS[kind]} primary display field drifted.`);
    }
  }
  const relationships = {};
  const expectedRelationships = objects.equipment && objects.type && objects.model ? {
    department: [objects.equipment.id, DEPARTMENT_OBJECT_ID, true],
    type: [objects.equipment.id, objects.type.id, true],
    model: [objects.equipment.id, objects.model.id, false],
    modelType: [objects.model.id, objects.type.id, true],
  } : {};
  for (const [kind, expected] of Object.entries(expectedRelationships)) {
    const matches = state.relationships.filter((item) => item.relationship_key === RELATIONSHIP_KEYS[kind]);
    relationships[kind] = matches[0] || null;
    if (matches.length !== 1) {
      if (!allowMissingSchema || matches.length > 1) {
        blockers.push(`${RELATIONSHIP_KEYS[kind]} must resolve exactly once; found ${matches.length}.`);
      }
      continue;
    }
    const [sourceId, targetId, required] = expected;
    const relationship = matches[0];
    if (relationship.source_kind !== 'custom_object' || relationship.target_kind !== 'custom_object'
      || relationship.source_custom_object_id !== sourceId || relationship.target_custom_object_id !== targetId
      || relationship.cardinality !== 'many_to_one' || relationship.is_required !== required
      || relationship.status !== 'active' || !relationship.show_on_source || !relationship.show_on_target
      || !relationship.edit_from_source || !relationship.edit_from_target) {
      blockers.push(`${RELATIONSHIP_KEYS[kind]} metadata drifted.`);
    }
  }
  return { blockers: [...new Set(blockers)], objects, fields, relationships };
}

export function makePlan(source, state, contract) {
  if (contract.blockers.length) return { blocked: true, types: [], models: [], equipment: [] };
  const activeRecords = state.records.filter((record) => !record.archived_at);
  const activeEdges = state.edges.filter((edge) => !edge.archived_at);
  const byObject = (id) => activeRecords.filter((record) => record.custom_object_id === id);
  const typeRecords = byObject(contract.objects.type.id);
  const modelRecords = byObject(contract.objects.model.id);
  const equipmentRecords = byObject(contract.objects.equipment.id);
  const unique = (matches, label) => {
    if (matches.length > 1) fail(`${label} is ambiguous (${matches.length} active records).`);
    return matches[0] || null;
  };
  const types = source.types.map((name) => {
    const record = unique(typeRecords.filter((item) => item.data?.name === name), `Equipment Type "${name}"`);
    return { name, record, action: record ? 'reuse' : 'create' };
  });
  const modelRows = [...new Map(source.rows.filter((row) => row.model).map((row) => [modelIdentity(row), row])).values()];
  const models = modelRows.map((row) => {
    const identity = modelIdentity(row);
    const record = unique(modelRecords.filter((item) => item.data?.source_identity === identity), `Model identity ${identity}`);
    return { identity, row, record, action: record ? 'reuse' : 'create' };
  });
  const equipment = source.rows.map((row) => {
    const record = unique(equipmentRecords.filter((item) => item.data?.source_identity === row.sourceIdentity), `Source identity ${row.sourceIdentity}`);
    return { row, record, action: record ? 'reuse' : 'create' };
  });
  for (const item of types.filter((candidate) => candidate.record)) {
    if (!equalJson(item.record.data, { name: item.name })) {
      fail(`Existing Equipment Type "${item.name}" data drifted.`);
    }
  }
  for (const item of models.filter((candidate) => candidate.record)) {
    const expectedData = {
      name: item.row.model,
      manufacturer: effectiveManufacturer(item.row),
      source_identity: item.identity,
    };
    if (!equalJson(item.record.data, expectedData)) fail(`Existing Model identity ${item.identity} data drifted.`);
    const edges = activeEdges.filter((edge) => edge.source_record_id === item.record.id);
    const expectedType = types.find((type) => type.name === item.row.equipmentType)?.record;
    if (!expectedType) {
      fail(`Existing Model identity ${item.identity} cannot be audited before its Equipment Type exists.`);
    }
    if (edges.length !== 1 || edges[0].relationship_definition_id !== contract.relationships.modelType.id
      || edges[0].target_record_id !== expectedType.id) {
      fail(`Existing Model identity ${item.identity} has the wrong Equipment Type relationship.`);
    }
  }
  for (const item of equipment.filter((candidate) => candidate.record)) {
    const recordEdges = activeEdges.filter((edge) => edge.source_record_id === item.record.id);
    if (!equalJson(item.record.data, equipmentData(item.row))) {
      fail(`Existing ${item.row.sourceIdentity} source values drifted.`);
    }
    const expectedType = types.find((type) => type.name === item.row.equipmentType)?.record;
    const expectedModel = item.row.model
      ? models.find((model) => model.identity === modelIdentity(item.row))?.record
      : null;
    if (!expectedType || (item.row.model && !expectedModel)) {
      fail(`Existing ${item.row.sourceIdentity} cannot be audited before its references exist.`);
    }
    const expectedEdges = [
      [contract.relationships.department.id, item.row.departmentId],
      [contract.relationships.type.id, expectedType.id],
      ...(expectedModel ? [[contract.relationships.model.id, expectedModel.id]] : []),
    ];
    if (recordEdges.length !== expectedEdges.length || expectedEdges.some(([definitionId, targetId]) =>
      !recordEdges.some((edge) =>
        edge.relationship_definition_id === definitionId && edge.target_record_id === targetId))) {
      fail(`Existing ${item.row.sourceIdentity} relationships drifted.`);
    }
  }
  return { blocked: false, types, models, equipment };
}

async function fetchAll(db, table, columns, configure) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await configure(db.from(table).select(columns).order('id').range(from, from + 499));
    check(error, `Could not load ${table}`);
    rows.push(...(data || []));
    if ((data || []).length < 500) return rows;
  }
}

async function loadState(db, source) {
  const [tenantResult, objectResult, fieldsResult, relationshipResult, departmentResult] = await Promise.all([
    db.from('tenant').select('id,name').eq('id', TENANT_ID).maybeSingle(),
    db.from('custom_object_definition').select('*').eq('tenant_id', TENANT_ID),
    db.from('preference_field').select('*').eq('tenant_id', TENANT_ID).eq('entity_scope', 'custom_object'),
    db.from('custom_object_relationship_definition').select('*').eq('tenant_id', TENANT_ID),
    db.from('custom_object_record').select('*').eq('tenant_id', TENANT_ID).in('id', source.departmentIds),
  ]);
  for (const [result, label] of [
    [tenantResult, 'tenant'], [objectResult, 'objects'], [fieldsResult, 'fields'],
    [relationshipResult, 'relationships'], [departmentResult, 'Departments'],
  ]) check(result.error, `Could not load ${label}`);
  const objectIds = (objectResult.data || [])
    .filter((object) => Object.values(OBJECT_KEYS).includes(object.object_key)).map((object) => object.id);
  const [records, edges] = await Promise.all([
    objectIds.length ? fetchAll(db, 'custom_object_record', '*',
      (query) => query.eq('tenant_id', TENANT_ID).in('custom_object_id', objectIds)) : [],
    fetchAll(db, 'custom_object_relationship', '*', (query) => query.eq('tenant_id', TENANT_ID)),
  ]);
  return {
    tenant: tenantResult.data,
    departmentObject: (objectResult.data || []).find((item) => item.id === DEPARTMENT_OBJECT_ID),
    objects: objectResult.data || [],
    fields: fieldsResult.data || [],
    relationships: relationshipResult.data || [],
    departments: departmentResult.data || [],
    records,
    edges,
  };
}

const fieldPayload = (objectId, contract, index) => {
  const [name, label, field_type, is_required] = contract;
  return {
    tenant_id: TENANT_ID, custom_object_id: objectId, entity_scope: 'custom_object',
    name, label, field_type, is_required, is_active: true, display_order: index,
    ...(name === 'still_in_service' ? { options: ['Yes', 'No'].map((value) => ({ label: value, value })) } : {}),
    created_by: ACTOR, updated_by: ACTOR,
  };
};

const detailConfiguration = (fieldIds, relationshipItems = []) => ({
  views: {
    list: { field_ids: fieldIds.slice(0, Math.min(fieldIds.length, 5)) },
    detail: {
      version: 2,
      schema_field_ids: fieldIds,
      cards: [{
        id: 'card-details',
        title: 'Details',
        columns: 2,
        fields: [
          ...fieldIds.map((id, index) => ({
            id: `field:${id}`, type: 'field', field_id: id, columnIndex: index % 2,
          })),
          ...relationshipItems,
        ],
      }],
      visibility_rules: { version: 1, rules: [] },
    },
  },
});

export const canResumeImporterPresentation = (object, fieldIds) =>
  object?.created_by === ACTOR
  && equalJson(object.configuration, detailConfiguration(fieldIds));

async function ensureSchema(db) {
  let { data: existing, error } = await db.from('custom_object_definition').select('*')
    .eq('tenant_id', TENANT_ID).in('object_key', Object.values(OBJECT_KEYS));
  check(error, 'Could not inspect equipment object definitions');
  const resolved = {};
  const newlyConfigured = new Set();
  for (const kind of ['type', 'model', 'equipment']) {
    const matches = (existing || []).filter((item) => item.object_key === OBJECT_KEYS[kind]);
    if (matches.length > 1) fail(`Refusing to reconcile duplicate ${OBJECT_KEYS[kind]} definitions.`);
    if (matches.length === 0) {
      const [singular_label, plural_label, description, icon] = OBJECT_CONTRACTS[kind];
      const result = await db.from('custom_object_definition').insert({
        tenant_id: TENANT_ID, object_key: OBJECT_KEYS[kind], singular_label, plural_label,
        description, icon, status: 'draft', created_by: ACTOR, updated_by: ACTOR,
      }).select().single();
      check(result.error, `Could not create ${OBJECT_KEYS[kind]}`);
      resolved[kind] = result.data;
      newlyConfigured.add(kind);
    } else {
      resolved[kind] = matches[0];
      if (resolved[kind].status !== 'draft' && resolved[kind].status !== 'active') {
        fail(`Existing ${OBJECT_KEYS[kind]} is not reconcilable from status ${resolved[kind].status}.`);
      }
    }
    const fieldResult = await db.from('preference_field').select('*').eq('tenant_id', TENANT_ID)
      .eq('custom_object_id', resolved[kind].id).eq('entity_scope', 'custom_object');
    check(fieldResult.error, `Could not inspect ${OBJECT_KEYS[kind]} fields`);
    const fields = [];
    for (const [index, fieldContract] of FIELD_CONTRACTS[kind].entries()) {
      const matchesForField = (fieldResult.data || []).filter((field) => field.name === fieldContract[0]);
      if (matchesForField.length > 1) fail(`Duplicate ${OBJECT_KEYS[kind]}.${fieldContract[0]} fields.`);
      if (matchesForField.length === 0) {
        if (resolved[kind].status !== 'draft') fail(`Active ${OBJECT_KEYS[kind]} is missing ${fieldContract[0]}.`);
        const insert = await db.from('preference_field').insert(fieldPayload(resolved[kind].id, fieldContract, index)).select().single();
        check(insert.error, `Could not create ${OBJECT_KEYS[kind]}.${fieldContract[0]}`);
        fields.push(insert.data);
        newlyConfigured.add(kind);
      } else fields.push(matchesForField[0]);
    }
    resolved[kind].fields = fields;
  }
  // Relationship-definition guards require both Custom Object endpoints to be
  // active. Activate the field-complete objects first, then add relationship
  // cards to their presentation after the definitions exist.
  for (const kind of ['type', 'model', 'equipment']) {
    const fieldIds = resolved[kind].fields.map((field) => field.id);
    if (resolved[kind].status === 'draft') {
      const activate = await db.from('custom_object_definition').update({
        primary_display_field_id: fieldIds[0],
        configuration: detailConfiguration(fieldIds),
        status: 'active', updated_by: ACTOR,
      }).eq('tenant_id', TENANT_ID).eq('id', resolved[kind].id);
      check(activate.error, `Could not activate ${OBJECT_KEYS[kind]} before relationship setup`);
      newlyConfigured.add(kind);
    }
  }
  const relationshipContracts = [
    ['department', resolved.equipment.id, DEPARTMENT_OBJECT_ID, 'Department', 'Equipment Register', true],
    ['type', resolved.equipment.id, resolved.type.id, 'Equipment Type', 'Equipment Register', true],
    ['model', resolved.equipment.id, resolved.model.id, 'Model', 'Equipment Register', false],
    ['modelType', resolved.model.id, resolved.type.id, 'Equipment Type', 'Models', true],
  ];
  const relationships = {};
  const allRelationships = await db.from('custom_object_relationship_definition').select('*').eq('tenant_id', TENANT_ID);
  check(allRelationships.error, 'Could not inspect equipment relationships');
  for (const [kind, sourceId, targetId, sourceLabel, targetLabel, required] of relationshipContracts) {
    const matches = (allRelationships.data || []).filter((item) => item.relationship_key === RELATIONSHIP_KEYS[kind]);
    if (matches.length > 1) fail(`Duplicate ${RELATIONSHIP_KEYS[kind]} definitions.`);
    if (matches.length === 0) {
      const insert = await db.from('custom_object_relationship_definition').insert({
        tenant_id: TENANT_ID, relationship_key: RELATIONSHIP_KEYS[kind],
        source_kind: 'custom_object', source_custom_object_id: sourceId,
        target_kind: 'custom_object', target_custom_object_id: targetId,
        cardinality: 'many_to_one', source_label: sourceLabel, target_label: targetLabel,
        is_required: required, show_on_source: true, show_on_target: true,
        edit_from_source: true, edit_from_target: true, status: 'active',
        configuration: {}, created_by: ACTOR, updated_by: ACTOR,
      }).select().single();
      check(insert.error, `Could not create ${RELATIONSHIP_KEYS[kind]}`);
      relationships[kind] = insert.data;
    } else relationships[kind] = matches[0];
  }
  for (const kind of ['type', 'model', 'equipment']) {
    const relationshipItems = Object.entries(relationships).flatMap(([relationshipKind, definition]) => {
      if (definition.source_custom_object_id === resolved[kind].id) {
        return [{ id: `relationship:${definition.id}:source`, type: 'relationship',
          relationship_definition_id: definition.id, side: 'source', columnIndex: 1 }];
      }
      if (definition.target_custom_object_id === resolved[kind].id) {
        return [{ id: `relationship:${definition.id}:target`, type: 'relationship',
          relationship_definition_id: definition.id, side: 'target', columnIndex: 1 }];
      }
      return [];
    });
    const fieldIds = resolved[kind].fields.map((field) => field.id);
    const expectedConfiguration = detailConfiguration(fieldIds, relationshipItems);
    if (!newlyConfigured.has(kind) && canResumeImporterPresentation(resolved[kind], fieldIds)) {
      newlyConfigured.add(kind);
    }
    if (newlyConfigured.has(kind)) {
      const update = await db.from('custom_object_definition').update({
        primary_display_field_id: fieldIds[0],
        configuration: expectedConfiguration,
        status: 'active', updated_by: ACTOR,
      }).eq('tenant_id', TENANT_ID).eq('id', resolved[kind].id);
      check(update.error, `Could not activate ${OBJECT_KEYS[kind]}`);
    } else if (resolved[kind].primary_display_field_id !== fieldIds[0]
      || !equalJson(resolved[kind].configuration, expectedConfiguration)) {
      fail(`Existing active ${OBJECT_KEYS[kind]} presentation drifted; refusing to overwrite it.`);
    }
  }
}

async function atomicCreate(db, objectId, data, relationships) {
  const result = await db.rpc('create_custom_object_record_with_relationships', {
    p_tenant_id: TENANT_ID,
    p_custom_object_id: objectId,
    p_data: data,
    p_relationships: relationships.map((item) => ({
      relationship_definition_id: item.definitionId,
      routed_side: 'source',
      related_record_id: item.recordId,
    })),
    p_created_by: ACTOR,
  });
  check(result.error, `Could not atomically create ${objectId} record`);
  return result.data.record;
}

export async function applyPlan(db, source, contract, plan) {
  if (plan.blocked) fail(`Import blocked: ${contract.blockers.join(' ')}`);
  const counts = {
    typesCreated: 0, typesReused: 0, modelsCreated: 0, modelsReused: 0,
    equipmentCreated: 0, equipmentReused: 0, relationshipsCreated: 0, rejected: 0,
  };
  const typeIds = new Map();
  for (const item of plan.types) {
    const record = item.record || await atomicCreate(db, contract.objects.type.id, { name: item.name }, []);
    typeIds.set(item.name, record.id);
    counts[item.record ? 'typesReused' : 'typesCreated'] += 1;
  }
  const modelIds = new Map();
  for (const item of plan.models) {
    const record = item.record || await atomicCreate(db, contract.objects.model.id, {
      name: item.row.model,
      manufacturer: effectiveManufacturer(item.row),
      source_identity: item.identity,
    }, [{ definitionId: contract.relationships.modelType.id, recordId: typeIds.get(item.row.equipmentType) }]);
    modelIds.set(item.identity, record.id);
    counts[item.record ? 'modelsReused' : 'modelsCreated'] += 1;
    if (!item.record) counts.relationshipsCreated += 1;
  }
  for (const item of plan.equipment) {
    if (!item.record) {
      const relationships = [
        { definitionId: contract.relationships.department.id, recordId: item.row.departmentId },
        { definitionId: contract.relationships.type.id, recordId: typeIds.get(item.row.equipmentType) },
        ...(item.row.model ? [{ definitionId: contract.relationships.model.id, recordId: modelIds.get(modelIdentity(item.row)) }] : []),
      ];
      await atomicCreate(db, contract.objects.equipment.id, equipmentData(item.row), relationships);
      counts.equipmentCreated += 1;
      counts.relationshipsCreated += relationships.length;
    } else counts.equipmentReused += 1;
  }
  return counts;
}

export function verify(source, state, contract) {
  const plan = makePlan(source, state, contract);
  if (plan.blocked || plan.types.some((item) => !item.record)
    || plan.models.some((item) => !item.record) || plan.equipment.some((item) => !item.record)) {
    fail('Post-import verification found missing schema or records.');
  }
  if (plan.equipment.length !== ROW_COUNT) fail(`Post-import verification found ${plan.equipment.length}/${ROW_COUNT} equipment rows.`);
  const expectedEquipmentIds = new Set(plan.equipment.map((item) => item.record.id));
  const allEquipment = state.records.filter((record) =>
    record.custom_object_id === contract.objects.equipment.id && !record.archived_at);
  if (allEquipment.length !== ROW_COUNT || allEquipment.some((record) => !expectedEquipmentIds.has(record.id))) {
    fail(`Equipment Register has ${allEquipment.length} active records instead of exactly ${ROW_COUNT} supplied rows.`);
  }
  for (const item of plan.equipment) {
    if (!equalJson(item.record.data, equipmentData(item.row))) {
      fail(`Equipment ${item.row.sourceIdentity} does not preserve the exact source values.`);
    }
    const edges = state.edges.filter((edge) => edge.source_record_id === item.record.id && !edge.archived_at);
    const expected = [
      [contract.relationships.department.id, item.row.departmentId],
      [contract.relationships.type.id, plan.types.find((type) => type.name === item.row.equipmentType).record.id],
      ...(item.row.model ? [[contract.relationships.model.id,
        plan.models.find((model) => model.identity === modelIdentity(item.row)).record.id]] : []),
    ];
    if (edges.length !== expected.length || expected.some(([definitionId, targetId]) =>
      !edges.some((edge) => edge.relationship_definition_id === definitionId && edge.target_record_id === targetId))) {
      fail(`Equipment ${item.row.sourceIdentity} relationships do not exactly match the source.`);
    }
  }
  for (const item of plan.models) {
    const expectedData = {
      name: item.row.model,
      manufacturer: effectiveManufacturer(item.row),
      source_identity: item.identity,
    };
    if (!equalJson(item.record.data, expectedData)) fail(`Model ${item.identity} data does not match the source.`);
    const edges = state.edges.filter((edge) => edge.source_record_id === item.record.id && !edge.archived_at);
    const type = plan.types.find((candidate) => candidate.name === item.row.equipmentType).record;
    if (edges.length !== 1 || edges[0].relationship_definition_id !== contract.relationships.modelType.id
      || edges[0].target_record_id !== type.id) {
      fail(`Model ${item.identity} does not have exactly one correct Equipment Type relationship.`);
    }
  }
  return {
    equipment: ROW_COUNT,
    departments: source.departmentIds.length,
    types: plan.types.length,
    models: plan.models.length,
    sourceIdenticalDuplicatesPreserved: source.duplicateCount,
    blankModelsWithoutInventedReferences: source.rows.filter((row) => !row.model).length,
    rejected: 0,
  };
}

const summary = (source, contract, plan, mode) => ({
  mode,
  csv: {
    fingerprint: source.fingerprint, rows: source.rows.length,
    departments: source.departmentIds.length, equipmentTypes: source.types.length,
    sourceIdenticalDuplicates: source.duplicateCount,
  },
  blockers: contract.blockers,
  resolved: {
    objects: Object.fromEntries(Object.entries(contract.objects).map(([key, value]) => [key, value?.id || null])),
    relationships: Object.fromEntries(Object.entries(contract.relationships).map(([key, value]) => [key, value?.id || null])),
  },
  intended: plan.blocked ? null : {
    typesCreate: plan.types.filter((item) => item.action === 'create').length,
    typesReuse: plan.types.filter((item) => item.action === 'reuse').length,
    modelsCreate: plan.models.filter((item) => item.action === 'create').length,
    modelsReuse: plan.models.filter((item) => item.action === 'reuse').length,
    equipmentCreate: plan.equipment.filter((item) => item.action === 'create').length,
    equipmentReuse: plan.equipment.filter((item) => item.action === 'reuse').length,
    blankModelRows: source.rows.filter((row) => !row.model).length,
  },
});

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply')) fail('Only --apply is supported.');
  const apply = args.includes('--apply');
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required.');
  }
  const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
  const source = readSource();
  let state = await loadState(db, source);
  const preview = auditLiveContract(source, state, { allowMissingSchema: true });
  if (preview.blockers.length) fail(`DRY RUN blocked without writes: ${preview.blockers.join(' ')}`);
  const schemaIncomplete = Object.values(preview.objects).some((object) => !object || object.status !== 'active')
    || Object.values(RELATIONSHIP_KEYS).some((key) =>
      !state.relationships.some((relationship) => relationship.relationship_key === key));
  if (!apply && schemaIncomplete) {
    console.log(JSON.stringify({
      ...summary(source, preview, { blocked: false, types: [], models: [], equipment: [] }, 'dry-run'),
      schemaAction: 'create and activate three objects, 13 fields, and four relationships',
      intended: {
        typesCreate: source.types.length,
        modelsCreate: new Set(source.rows.map(modelIdentity).filter(Boolean)).size,
        equipmentCreate: source.rows.length,
        blankModelRows: source.rows.filter((row) => !row.model).length,
      },
    }, null, 2));
    return console.log('DRY RUN complete: contract and intended schema validated; no writes.');
  }
  if (apply) {
    await ensureSchema(db);
    state = await loadState(db, source);
  }
  let contract = auditLiveContract(source, state);
  let plan = makePlan(source, state, contract);
  console.log(JSON.stringify(summary(source, contract, plan, apply ? 'apply' : 'dry-run'), null, 2));
  if (contract.blockers.length) fail(`Import blocked: ${contract.blockers.join(' ')}`);
  if (!apply) return console.log('DRY RUN complete: no writes.');
  const counts = await applyPlan(db, source, contract, plan);
  state = await loadState(db, source);
  contract = auditLiveContract(source, state);
  const verification = verify(source, state, contract);
  const replay = makePlan(source, state, contract);
  if (replay.types.some((item) => item.action !== 'reuse')
    || replay.models.some((item) => item.action !== 'reuse')
    || replay.equipment.some((item) => item.action !== 'reuse')) fail('Zero-write replay would create duplicates.');
  console.log(JSON.stringify({
    counts,
    verification,
    zeroWriteReplay: {
      typesReused: replay.types.length,
      modelsReused: replay.models.length,
      equipmentReused: replay.equipment.length,
      writes: 0,
    },
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
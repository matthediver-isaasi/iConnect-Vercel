#!/usr/bin/env node
/**
 * Dry-run-first, destination-only BNMS Organisation hierarchy importer.
 *
 * Usage:
 *   node scripts/import-bnms-organisation-hierarchy.mjs
 *   node scripts/import-bnms-organisation-hierarchy.mjs --apply
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import XLSX from 'xlsx';
import {
  validateCustomObjectFieldDefinition,
  validateCustomObjectRecordData,
  validateCustomObjectRelationshipDefinition,
} from '../api/_lib/customObjectDomain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'attached_assets', 'Organisations_and_departments_import_27.08.26_reduced_1787841406049.xlsx');
const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const OBJECT_KEY = 'org_department';
const RELATIONSHIP_KEY = 'organisation';
const TYPE_OBJECT_KEY = 'department_type';
const TYPE_RELATIONSHIP_KEY = 'department_type';
const SHEET = 'Sheet1';
const HEADERS = ['Department object', 'Organisation', 'Organisation Group uuid'];
const ROW_COUNT = 310;
const ORGANISATION_COUNT = 231;
const DEPARTMENT_COUNT = 310;
const MULTI_DEPARTMENT_ORGANISATION_COUNT = 69;
const TYPE_TOTALS = new Map([
  ['nuclear medicine physics based', 32],
  ['pet centre', 33],
  ['radiopharmacy', 71],
  ['radiology based nuclear medicine', 95],
  ['nuclear medicine stand alone', 78],
  ['nuclear cardiology', 1],
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPLY_LOCK_NAME = 'bnms-department-type-normalization-v1';
const { Client: PgClient } = pg;

function fail(message) { throw new Error(message); }
function identityNormalise(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-GB');
}
function normalise(value) {
  return identityNormalise(value)
    .replace(/[\u0096\u2010-\u2015-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function client() {
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required; SOURCE and bare SUPABASE credentials are forbidden.');
  }
  return createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
    auth: { persistSession: false },
  });
}
function check(error, context) {
  if (error) fail(`${context}: ${error.message}`);
}
function importIdentity(row) {
  const pair = `${identityNormalise(row.organisationName)}::${identityNormalise(row.departmentName)}`;
  const hash = createHash('sha256').update(pair).digest('hex').slice(0, 32);
  return `system:bnms-org-hierarchy:${hash}`;
}
async function acquireApplyLock() {
  if (!process.env.DEST_DATABASE_URL) {
    fail('DEST_DATABASE_URL is required in apply mode to serialize the import.');
  }
  const lockClient = new PgClient({
    connectionString: process.env.DEST_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await lockClient.connect();
  try {
    await lockClient.query('BEGIN');
    const result = await lockClient.query(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
      [APPLY_LOCK_NAME],
    );
    if (result.rows[0]?.acquired !== true) {
      fail('Another BNMS Organisation hierarchy apply is already running; no writes were made.');
    }
    return lockClient;
  } catch (error) {
    await lockClient.end().catch(() => {});
    throw error;
  }
}
async function releaseApplyLock(lockClient) {
  if (!lockClient) return;
  try {
    await lockClient.query('ROLLBACK');
  } finally {
    await lockClient.end();
  }
}

export function readSource() {
  const workbook = XLSX.readFile(FILE);
  if (!workbook.SheetNames.includes(SHEET)) fail(`Workbook must contain ${SHEET}.`);
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[SHEET], {
    header: 1, defval: null, raw: false,
  });
  const actualHeaders = (grid[0] || []).map((value) => String(value ?? '').trim());
  if (actualHeaders.length !== HEADERS.length
    || actualHeaders.some((value, index) => value !== HEADERS[index])) {
    fail(`${SHEET} headers must be exactly: ${HEADERS.join(' | ')}. Found: ${actualHeaders.join(' | ') || '(none)'}.`);
  }
  const rows = [];
  for (let index = 1; index < grid.length; index += 1) {
    const values = HEADERS.map((_, column) => String(grid[index]?.[column] ?? '').trim());
    if (values.every((value) => !value)) continue;
    const missing = HEADERS.filter((_, column) => !values[column]);
    if (missing.length) fail(`${SHEET} row ${index + 1} is missing: ${missing.join(', ')}.`);
    if (!UUID_RE.test(values[2])) fail(`${SHEET} row ${index + 1} has invalid Organisation Group UUID "${values[2]}".`);
    rows.push({
      sourceRow: index + 1,
      departmentName: values[0],
      organisationName: values[1],
      groupId: values[2].toLowerCase(),
    });
  }
  if (rows.length !== ROW_COUNT) fail(`${SHEET} must contain ${ROW_COUNT} populated rows; found ${rows.length}.`);

  const organisations = new Map();
  const pairs = new Map();
  for (const row of rows) {
    const organisationKey = normalise(row.organisationName);
    const departmentKey = normalise(row.departmentName);
    const existingOrganisation = organisations.get(organisationKey);
    if (existingOrganisation && existingOrganisation.groupId !== row.groupId) {
      fail(`Organisation "${row.organisationName}" has inconsistent group UUIDs at rows ${existingOrganisation.sourceRow} and ${row.sourceRow}.`);
    }
    if (!existingOrganisation) organisations.set(organisationKey, row);
    const pairKey = `${organisationKey}::${departmentKey}`;
    if (pairs.has(pairKey)) {
      fail(`Duplicate normalised Department/Organisation pair at rows ${pairs.get(pairKey).sourceRow} and ${row.sourceRow}.`);
    }
    pairs.set(pairKey, row);
  }
  const departmentCounts = new Map();
  for (const row of rows) {
    const key = normalise(row.organisationName);
    departmentCounts.set(key, (departmentCounts.get(key) || 0) + 1);
  }
  const multiCount = [...departmentCounts.values()].filter((count) => count > 1).length;
  if (organisations.size !== ORGANISATION_COUNT || pairs.size !== DEPARTMENT_COUNT
    || multiCount !== MULTI_DEPARTMENT_ORGANISATION_COUNT) {
    fail(`Source shape mismatch: expected ${ORGANISATION_COUNT} Organisations, ${DEPARTMENT_COUNT} pairs, and ${MULTI_DEPARTMENT_ORGANISATION_COUNT} multi-Department Organisations; found ${organisations.size}, ${pairs.size}, and ${multiCount}.`);
  }
  const types = new Map();
  for (const row of rows) {
    const key = normalise(row.departmentName);
    const type = types.get(key) || { name: row.departmentName, count: 0 };
    type.count += 1;
    types.set(key, type);
  }
  if (types.size !== TYPE_TOTALS.size) {
    fail(`Source must derive exactly ${TYPE_TOTALS.size} Department Types; found ${types.size}.`);
  }
  for (const [key, expected] of TYPE_TOTALS) {
    const actual = types.get(key)?.count || 0;
    if (actual !== expected) {
      fail(`Source Department Type "${types.get(key)?.name || key}" must contain ${expected} rows; found ${actual}.`);
    }
  }
  return {
    rows, organisations, pairs, types,
    groupIds: [...new Set(rows.map((row) => row.groupId))],
  };
}

async function fetchAll(db, table, columns, configure = (query) => query) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    let query = db.from(table).select(columns).order('id', { ascending: true }).range(from, from + 499);
    query = configure(query);
    const { data, error } = await query;
    check(error, `Could not read ${table}`);
    rows.push(...(data || []));
    if ((data || []).length < 500) return rows;
  }
}

async function auditTenantAndGroups(db, source) {
  const { data: tenant, error: tenantError } = await db.from('tenant')
    .select('id, name').eq('id', TENANT_ID).maybeSingle();
  check(tenantError, 'Could not resolve pinned BNMS tenant');
  if (tenant?.id !== TENANT_ID || !/\bbnms\b|british nuclear medicine society/i.test(tenant.name || '')) {
    fail(`Pinned tenant is not BNMS (${tenant?.name || 'not found'}).`);
  }
  const groups = [];
  for (let index = 0; index < source.groupIds.length; index += 100) {
    const { data, error } = await db.from('organization_group')
      .select('id, tenant_id, name').in('id', source.groupIds.slice(index, index + 100));
    check(error, 'Could not resolve supplied Organisation Groups');
    groups.push(...(data || []));
  }
  const byId = new Map();
  for (const group of groups) {
    if (byId.has(group.id)) fail(`Organisation Group UUID ${group.id} resolved ambiguously.`);
    byId.set(group.id, group);
  }
  const missing = source.groupIds.filter((id) => !byId.has(id));
  const foreign = groups.filter((group) => group.tenant_id !== TENANT_ID);
  if (missing.length || foreign.length) {
    fail(`Organisation Group ownership check failed: ${missing.length} missing, ${foreign.length} outside BNMS.`);
  }
  return { tenant, groups: byId };
}

async function auditModel(db) {
  const objects = await fetchAll(db, 'custom_object_definition', '*',
    (query) => query.eq('tenant_id', TENANT_ID).eq('object_key', OBJECT_KEY));
  if (objects.length !== 1) fail(`Expected exactly one BNMS ${OBJECT_KEY} definition; found ${objects.length}.`);
  const object = objects[0];
  if (object.status !== 'active') fail('BNMS Organisation Department object must be active.');
  const fields = await fetchAll(db, 'preference_field', '*',
    (query) => query.eq('tenant_id', TENANT_ID).eq('custom_object_id', object.id));
  const nameFields = fields.filter((field) => field.name === 'name');
  if (nameFields.length !== 1) fail(`Expected exactly one Organisation Department name field; found ${nameFields.length}.`);
  const nameField = nameFields[0];
  const fieldValidation = validateCustomObjectFieldDefinition(nameField, {
    tenantId: TENANT_ID, customObjectId: object.id,
  });
  if (!fieldValidation.ok || !nameField.is_active || !nameField.is_required
    || nameField.field_type !== 'text' || object.primary_display_field_id !== nameField.id) {
    fail(`Organisation Department name field is invalid: ${fieldValidation.errors.join('; ') || 'must be active, required text and the primary display field'}.`);
  }
  const definitions = await fetchAll(db, 'custom_object_relationship_definition', '*',
    (query) => query.eq('tenant_id', TENANT_ID).eq('relationship_key', RELATIONSHIP_KEY));
  if (definitions.length !== 1) fail(`Expected exactly one BNMS ${RELATIONSHIP_KEY} relationship definition; found ${definitions.length}.`);
  const definition = definitions[0];
  const validation = validateCustomObjectRelationshipDefinition(definition);
  if (!validation.ok) fail(`Department relationship definition is invalid: ${validation.errors.join('; ')}.`);
  if (definition.source_kind !== 'custom_object'
    || definition.source_custom_object_id !== object.id
    || definition.target_kind !== 'organization'
    || definition.target_custom_object_id !== null
    || definition.status !== 'active'
    || !definition.is_required) {
    fail('The active required Organisation Department-to-Organisation relationship endpoints do not match the approved model.');
  }
  if (!['one_to_one', 'many_to_one'].includes(definition.cardinality)) {
    fail(`Unexpected Department relationship cardinality "${definition.cardinality}".`);
  }
  const typeObjects = await fetchAll(db, 'custom_object_definition', '*',
    (query) => query.eq('tenant_id', TENANT_ID).eq('object_key', TYPE_OBJECT_KEY));
  if (typeObjects.length !== 1 || typeObjects[0].status !== 'active') {
    fail(`Expected exactly one active BNMS ${TYPE_OBJECT_KEY} definition; found ${typeObjects.length}. Run the Department Type migration first.`);
  }
  const typeObject = typeObjects[0];
  const typeFields = await fetchAll(db, 'preference_field', '*',
    (query) => query.eq('tenant_id', TENANT_ID).eq('custom_object_id', typeObject.id));
  const typeNameFields = typeFields.filter((field) => field.name === 'name');
  if (typeNameFields.length !== 1) fail(`Expected exactly one Department Type name field; found ${typeNameFields.length}.`);
  const typeNameField = typeNameFields[0];
  const typeFieldValidation = validateCustomObjectFieldDefinition(typeNameField, {
    tenantId: TENANT_ID, customObjectId: typeObject.id,
  });
  if (!typeFieldValidation.ok || !typeNameField.is_active || !typeNameField.is_required
    || typeNameField.field_type !== 'text' || typeObject.primary_display_field_id !== typeNameField.id) {
    fail(`Department Type name field is invalid: ${typeFieldValidation.errors.join('; ') || 'must be active, required text and the primary display field'}.`);
  }
  const typeDefinitions = await fetchAll(db, 'custom_object_relationship_definition', '*',
    (query) => query.eq('tenant_id', TENANT_ID).eq('relationship_key', TYPE_RELATIONSHIP_KEY));
  if (typeDefinitions.length !== 1) fail(`Expected exactly one BNMS ${TYPE_RELATIONSHIP_KEY} relationship definition; found ${typeDefinitions.length}.`);
  const typeDefinition = typeDefinitions[0];
  const typeValidation = validateCustomObjectRelationshipDefinition(typeDefinition);
  if (!typeValidation.ok || typeDefinition.source_kind !== 'custom_object'
    || typeDefinition.source_custom_object_id !== object.id
    || typeDefinition.target_kind !== 'custom_object'
    || typeDefinition.target_custom_object_id !== typeObject.id
    || typeDefinition.cardinality !== 'many_to_one' || !typeDefinition.is_required
    || typeDefinition.status !== 'active') {
    fail('The active required Department-to-Department-Type relationship does not match the approved model.');
  }
  return {
    object, fields, nameField, definition,
    typeObject, typeFields, typeNameField, typeDefinition,
  };
}

function uniqueMap(rows, sourceKeys, label) {
  const map = new Map();
  const duplicates = new Map();
  for (const row of rows) {
    const key = normalise(row.name);
    if (!key) continue;
    if (map.has(key)) duplicates.set(key, [...(duplicates.get(key) || [map.get(key)]), row]);
    else map.set(key, row);
  }
  for (const [key, matches] of duplicates) {
    if (sourceKeys.has(key)) fail(`Ambiguous existing ${label} match: ${matches.map((row) => `"${row.name}" (${row.id})`).join(', ')}.`);
  }
  return map;
}

async function loadState(db, source, model) {
  const organisations = await fetchAll(db, 'organization', 'id, tenant_id, name, organization_group_id',
    (query) => query.eq('tenant_id', TENANT_ID));
  const organisationMap = uniqueMap(organisations, new Set(source.organisations.keys()), 'Organisation');
  const records = await fetchAll(db, 'custom_object_record', 'id, tenant_id, custom_object_id, data, created_by, archived_at',
    (query) => query.eq('tenant_id', TENANT_ID).eq('custom_object_id', model.object.id).is('archived_at', null));
  const importIdentities = new Set(source.rows.map(importIdentity));
  const archivedImportedRecords = (await fetchAll(db, 'custom_object_record', 'id, created_by, archived_at',
    (query) => query.eq('tenant_id', TENANT_ID).eq('custom_object_id', model.object.id)
      .not('archived_at', 'is', null)))
    .filter((record) => importIdentities.has(record.created_by));
  if (archivedImportedRecords.length) {
    fail(`Approved Department data is archived (${archivedImportedRecords.map((record) => record.id).join(', ')}).`);
  }
  const edges = await fetchAll(db, 'custom_object_relationship', 'id, tenant_id, relationship_definition_id, source_record_id, target_record_id, archived_at',
    (query) => query.eq('tenant_id', TENANT_ID).eq('relationship_definition_id', model.definition.id).is('archived_at', null));
  const typeRecords = await fetchAll(db, 'custom_object_record', 'id, tenant_id, custom_object_id, data, created_by, updated_by, archived_at',
    (query) => query.eq('tenant_id', TENANT_ID).eq('custom_object_id', model.typeObject.id));
  const typeEdges = await fetchAll(db, 'custom_object_relationship', 'id, tenant_id, relationship_definition_id, source_record_id, target_record_id, archived_at',
    (query) => query.eq('tenant_id', TENANT_ID).eq('relationship_definition_id', model.typeDefinition.id));
  const edgeBySource = new Map();
  const edgePairs = new Map();
  for (const edge of edges) {
    if (edgeBySource.has(edge.source_record_id)) fail(`Department record ${edge.source_record_id} has multiple active Organisation edges.`);
    edgeBySource.set(edge.source_record_id, edge);
    edgePairs.set(`${edge.source_record_id}::${edge.target_record_id}`, edge);
  }
  const departmentsByOrganisationAndName = new Map();
  const recoverableByIdentity = new Map();
  for (const row of source.rows) recoverableByIdentity.set(importIdentity(row), row);
  for (const record of records) {
    const validation = validateCustomObjectRecordData({ data: record.data, fields: model.fields, mode: 'read' });
    if (!validation.ok) fail(`Existing Department ${record.id} has invalid data: ${validation.errors.map((item) => item.message).join('; ')}.`);
    const edge = edgeBySource.get(record.id);
    if (!edge) {
      const sourceRow = recoverableByIdentity.get(record.created_by);
      if (!sourceRow) continue; // Preserve and ignore unrelated unlinked records.
      if (normalise(record.data?.name) !== normalise(sourceRow.departmentName)) {
        fail(`Recoverable Department ${record.id} does not match its import identity.`);
      }
      const organisation = organisationMap.get(normalise(sourceRow.organisationName));
      if (!organisation) continue;
      const recoveryKey = `${organisation.id}::${normalise(sourceRow.departmentName)}`;
      if (departmentsByOrganisationAndName.has(recoveryKey)) {
        fail(`More than one active Department matches source row ${sourceRow.sourceRow}.`);
      }
      departmentsByOrganisationAndName.set(recoveryKey, record);
      continue;
    }
    const key = `${edge.target_record_id}::${normalise(record.data?.name)}`;
    if (departmentsByOrganisationAndName.has(key)) fail(`Ambiguous existing active Department match within Organisation ${edge.target_record_id}.`);
    departmentsByOrganisationAndName.set(key, record);
  }
  const typeByName = new Map();
  for (const record of typeRecords) {
    const key = normalise(record.data?.name);
    if (!source.types.has(key)) {
      if (!record.archived_at) fail(`Unexpected active Department Type "${record.data?.name || record.id}".`);
      continue;
    }
    if (record.archived_at) fail(`Approved Department Type "${record.data?.name}" is archived.`);
    if (typeByName.has(key)) fail(`Ambiguous active Department Type "${record.data?.name}".`);
    const validation = validateCustomObjectRecordData({ data: record.data, fields: model.typeFields, mode: 'read' });
    if (!validation.ok) fail(`Department Type ${record.id} has invalid data: ${validation.errors.map((item) => item.message).join('; ')}.`);
    typeByName.set(key, record);
  }
  const typeEdgeByDepartment = new Map();
  const approvedDepartmentIds = new Set(
    [...departmentsByOrganisationAndName.values()].map((record) => record.id),
  );
  for (const edge of typeEdges) {
    if (edge.archived_at) {
      if (approvedDepartmentIds.has(edge.source_record_id)) {
        fail(`Approved Department ${edge.source_record_id} has archived Department Type relationship history; refusing to replace audit history.`);
      }
      continue;
    }
    if (typeEdgeByDepartment.has(edge.source_record_id)) fail(`Department ${edge.source_record_id} has multiple active Department Type links.`);
    typeEdgeByDepartment.set(edge.source_record_id, edge);
  }
  return {
    organisations, organisationMap, records, edges, edgeBySource, edgePairs, departmentsByOrganisationAndName,
    typeRecords, typeEdges, typeByName, typeEdgeByDepartment,
  };
}

export function makePlan(source, model, state) {
  const organisations = [...source.organisations.entries()].map(([key, row]) => {
    const existing = state.organisationMap.get(key);
    if (!existing || existing.organization_group_id !== row.groupId) {
      fail(`Source Organisation "${row.organisationName}" is missing, archived, or has a conflicting Organisation Group.`);
    }
    return {
      key, row, existing,
      action: 'unchanged',
    };
  });
  const departments = source.rows.map((row) => {
    const organisation = state.organisationMap.get(normalise(row.organisationName));
    const existing = organisation
      ? state.departmentsByOrganisationAndName.get(`${organisation.id}::${normalise(row.departmentName)}`)
      : null;
    const edge = existing ? state.edgeBySource.get(existing.id) : null;
    if (!organisation || !existing || !edge) {
      fail(`Source row ${row.sourceRow} does not resolve to exactly one active existing Department and Organisation relationship.`);
    }
    const type = state.typeByName.get(normalise(row.departmentName));
    const typeEdge = state.typeEdgeByDepartment.get(existing.id);
    if (typeEdge && (!type || typeEdge.target_record_id !== type.id)) {
      fail(`Department ${existing.id} has a conflicting active Department Type link.`);
    }
    return {
      row, organisation, existing, edge,
      type,
      typeEdge,
      departmentAction: 'unchanged',
      relationshipAction: 'unchanged',
      typeAction: type ? 'unchanged' : 'create',
      typeRelationshipAction: typeEdge ? 'unchanged' : 'create',
    };
  });
  if (new Set(departments.map((item) => item.existing.id)).size !== DEPARTMENT_COUNT) {
    fail('The approved source rows do not resolve to 310 distinct existing Department records.');
  }
  return {
    cardinalityAction: model.definition.cardinality === 'many_to_one' ? 'unchanged' : 'migration-required',
    organisations,
    departments,
  };
}

function count(items, key, value) { return items.filter((item) => item[key] === value).length; }
function report(source, audit, model, plan) {
  console.log('\n--- Validated source and destination ---');
  console.log(`  Tenant:                          ${audit.tenant.name} (${audit.tenant.id})`);
  console.log(`  Sheet read:                      ${SHEET} only`);
  console.log(`  Source rows / pairs:             ${source.rows.length}/${source.pairs.size}`);
  console.log(`  Unique Organisations:           ${source.organisations.size}`);
  console.log(`  Multi-Department Organisations: ${MULTI_DEPARTMENT_ORGANISATION_COUNT}`);
  console.log(`  Supplied Groups owned by BNMS:  ${audit.groups.size}/${source.groupIds.length}`);
  console.log(`  Department object:              ${model.object.id}`);
  console.log(`  Department relationship:        ${model.definition.id}`);
  console.log(`  Department Type object:         ${model.typeObject.id}`);
  console.log(`  Department Type relationship:   ${model.typeDefinition.id}`);
  console.log('\n--- Planned totals ---');
  console.log(`  Cardinality:                     ${model.definition.cardinality} -> many_to_one (${plan.cardinalityAction})`);
  console.log(`  Organisations create/update/unchanged: ${count(plan.organisations, 'action', 'create')}/${count(plan.organisations, 'action', 'update')}/${count(plan.organisations, 'action', 'unchanged')}`);
  console.log(`  Departments create/unchanged:          ${count(plan.departments, 'departmentAction', 'create')}/${count(plan.departments, 'departmentAction', 'unchanged')}`);
  console.log(`  Relationships create/unchanged:        ${count(plan.departments, 'relationshipAction', 'create')}/${count(plan.departments, 'relationshipAction', 'unchanged')}`);
  const typesToCreate = [...source.types.keys()].filter((key) => !plan.departments.find((item) => normalise(item.row.departmentName) === key)?.type).length;
  console.log(`  Department Types create/reuse:         ${typesToCreate}/${source.types.size - typesToCreate}`);
  console.log(`  Department Type links create/unchanged: ${count(plan.departments, 'typeRelationshipAction', 'create')}/${count(plan.departments, 'typeRelationshipAction', 'unchanged')}`);
  console.log('\n--- Every planned Organisation and group assignment ---');
  for (const item of plan.organisations) {
    console.log(`  Row ${item.row.sourceRow}: ${item.action.toUpperCase()} Organisation "${item.row.organisationName}" -> Group ${item.row.groupId}`);
  }
  console.log('\n--- Every planned Department relationship ---');
  for (const item of plan.departments) {
    console.log(`  Row ${item.row.sourceRow}: KEEP Department "${item.row.departmentName}" -> ${item.typeRelationshipAction.toUpperCase()} Department Type "${item.row.departmentName}"`);
  }
}

async function scopeCounts(db, outside) {
  const result = {};
  for (const table of ['organization', 'custom_object_record', 'custom_object_relationship', 'custom_object_relationship_definition']) {
    let query = db.from(table).select('id', { count: 'exact', head: true });
    query = outside ? query.neq('tenant_id', TENANT_ID) : query.eq('tenant_id', TENANT_ID);
    const { count: total, error } = await query;
    check(error, `Could not snapshot ${table}`);
    result[table] = total;
  }
  return result;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

async function snapshotApprovedDepartments(db, state, model) {
  const ids = new Set([...state.departmentsByOrganisationAndName.values()].map((record) => record.id));
  const records = [...state.departmentsByOrganisationAndName.values()]
    .map((record) => [record.id, digest(record.data)]).sort(([a], [b]) => a.localeCompare(b));
  const incidentDefinitions = (await fetchAll(db, 'custom_object_relationship_definition',
    'id, source_custom_object_id, target_custom_object_id',
    (query) => query.eq('tenant_id', TENANT_ID)))
    .filter((definition) => definition.id !== model.typeDefinition.id
      && (definition.source_custom_object_id === model.object.id
        || definition.target_custom_object_id === model.object.id));
  const definitionsById = new Map(incidentDefinitions.map((definition) => [definition.id, definition]));
  const relationships = (await fetchAll(db, 'custom_object_relationship',
    'id, relationship_definition_id, source_record_id, target_record_id, archived_at',
    (query) => query.eq('tenant_id', TENANT_ID)))
    .filter((edge) => {
      const definition = definitionsById.get(edge.relationship_definition_id);
      return definition && (
        (definition.source_custom_object_id === model.object.id && ids.has(edge.source_record_id))
        || (definition.target_custom_object_id === model.object.id && ids.has(edge.target_record_id))
      );
    })
    .map((edge) => [edge.id, edge.relationship_definition_id, edge.source_record_id, edge.target_record_id, edge.archived_at])
    .sort(([a], [b]) => a.localeCompare(b));
  const relationshipIds = new Set(relationships.map(([id]) => id));
  const audits = (await fetchAll(db, 'custom_object_audit_event', 'id, record_id, relationship_id',
    (query) => query.eq('tenant_id', TENANT_ID)))
    .filter((event) => ids.has(event.record_id) || relationshipIds.has(event.relationship_id))
    .map((event) => event.id).sort();
  return { records, relationships, audits };
}

async function applyPlan(db, source, model, state, plan) {
  if (plan.cardinalityAction !== 'unchanged') {
    fail('Apply is blocked until migration 20260827_bnms_department_many_to_one.sql has set the relationship cardinality to many_to_one.');
  }
  const result = {
    types: { created: 0, unchanged: 0 },
    typeRelationships: { created: 0, unchanged: 0 },
  };
  for (const [key, sourceType] of source.types) {
    let type = state.typeByName.get(key);
    if (!type) {
      const validated = validateCustomObjectRecordData({
        data: { name: sourceType.name }, fields: model.typeFields, mode: 'create',
      });
      if (!validated.ok) fail(`Department Type "${sourceType.name}" is invalid: ${validated.errors.map((item) => item.message).join('; ')}.`);
      const { data, error } = await db.from('custom_object_record').insert({
        tenant_id: TENANT_ID, custom_object_id: model.typeObject.id, data: validated.data,
        created_by: 'system:bnms-department-type-normalization',
        updated_by: 'system:bnms-department-type-normalization',
      }).select('id, tenant_id, custom_object_id, data, created_by, updated_by, archived_at').single();
      check(error, `Could not create Department Type "${sourceType.name}"`);
      if (!data?.id || data.tenant_id !== TENANT_ID || data.custom_object_id !== model.typeObject.id) fail('Invalid Department Type creation response.');
      type = data;
      state.typeByName.set(key, type);
      result.types.created += 1;
    } else result.types.unchanged += 1;
  }
  for (const item of plan.departments) {
    const type = state.typeByName.get(normalise(item.row.departmentName));
    if (!type?.id) fail(`No Department Type resolved for source row ${item.row.sourceRow}.`);
    if (!state.typeEdgeByDepartment.has(item.existing.id)) {
      const { data, error } = await db.from('custom_object_relationship').insert({
        tenant_id: TENANT_ID, relationship_definition_id: model.typeDefinition.id,
        source_record_id: item.existing.id, target_record_id: type.id,
        created_by: 'system:bnms-department-type-normalization',
      }).select('id, tenant_id, relationship_definition_id, source_record_id, target_record_id, archived_at').single();
      check(error, `Could not link Department Type at source row ${item.row.sourceRow}`);
      if (!data?.id || data.source_record_id !== item.existing.id || data.target_record_id !== type.id) fail('Invalid Department Type relationship creation response.');
      state.typeEdgeByDepartment.set(item.existing.id, data);
      result.typeRelationships.created += 1;
    } else result.typeRelationships.unchanged += 1;
  }
  return result;
}

async function verify(db, source, audit, model, outsideBefore, preservationBefore) {
  const refreshedModel = await auditModel(db);
  if (refreshedModel.definition.cardinality !== 'many_to_one' || !refreshedModel.definition.is_required) {
    fail('Post-import relationship definition is not required many_to_one.');
  }
  const state = await loadState(db, source, refreshedModel);
  const preservationAfter = await snapshotApprovedDepartments(db, state, refreshedModel);
  if (digest(preservationBefore.records) !== digest(preservationAfter.records)
    || digest(preservationBefore.relationships) !== digest(preservationAfter.relationships)
    || preservationBefore.audits.some((id) => !preservationAfter.audits.includes(id))) {
    fail('Preservation verification failed: an existing Department record, non-Type relationship, or audit history changed.');
  }
  const plan = makePlan(source, refreshedModel, state);
  const sourceOrganisationIds = new Set();
  const failures = [];
  for (const [key, row] of source.organisations) {
    const organisation = state.organisationMap.get(key);
    if (!organisation) failures.push(`missing Organisation "${row.organisationName}"`);
    else {
      sourceOrganisationIds.add(organisation.id);
      if (organisation.organization_group_id !== row.groupId) failures.push(`wrong group for "${row.organisationName}"`);
    }
  }
  let verifiedDepartments = 0;
  for (const row of source.rows) {
    const organisation = state.organisationMap.get(normalise(row.organisationName));
    const department = organisation && state.departmentsByOrganisationAndName
      .get(`${organisation.id}::${normalise(row.departmentName)}`);
    const edge = department && state.edgePairs.get(`${department.id}::${organisation.id}`);
    const type = state.typeByName.get(normalise(row.departmentName));
    const typeEdge = department && state.typeEdgeByDepartment.get(department.id);
    if (!department || !edge || !type || !typeEdge || typeEdge.target_record_id !== type.id) {
      failures.push(`missing or incorrect Department Type relationship at source row ${row.sourceRow}`);
    } else verifiedDepartments += 1;
  }
  if (failures.length) fail(`Post-import verification failed: ${failures.slice(0, 10).join('; ')}${failures.length > 10 ? `; and ${failures.length - 10} more` : ''}.`);
  if (sourceOrganisationIds.size !== ORGANISATION_COUNT || verifiedDepartments !== DEPARTMENT_COUNT) {
    fail('Post-import exact-count verification failed.');
  }
  for (const [key, sourceType] of source.types) {
    const type = state.typeByName.get(key);
    const total = type ? [...state.typeEdgeByDepartment.values()]
      .filter((edge) => edge.target_record_id === type.id).length : 0;
    if (total !== sourceType.count) failures.push(`Department Type "${sourceType.name}" total is ${total}, expected ${sourceType.count}`);
  }
  if (failures.length) fail(`Post-import type verification failed: ${failures.slice(0, 10).join('; ')}.`);
  if (plan.organisations.some((item) => item.action !== 'unchanged')
    || plan.departments.some((item) => item.departmentAction !== 'unchanged'
      || item.relationshipAction !== 'unchanged' || item.typeAction !== 'unchanged'
      || item.typeRelationshipAction !== 'unchanged')) {
    fail('Idempotency check failed: a second run would still write hierarchy data.');
  }
  const outsideAfter = await scopeCounts(db, true);
  if (digest(outsideBefore) !== digest(outsideAfter)) fail('Tenant-isolation verification failed: non-BNMS relevant row counts changed.');
  console.log('\n--- Post-import verification ---');
  console.log(`  Organisations exactly resolved:        ${sourceOrganisationIds.size}/${ORGANISATION_COUNT}`);
  console.log(`  Organisation-to-Group assignments:     ${sourceOrganisationIds.size}/${ORGANISATION_COUNT}`);
  console.log(`  Departments exactly resolved:          ${verifiedDepartments}/${DEPARTMENT_COUNT}`);
  console.log(`  Department-to-Organisation links:      ${verifiedDepartments}/${DEPARTMENT_COUNT}`);
  console.log(`  Department-to-Type links:              ${verifiedDepartments}/${DEPARTMENT_COUNT}`);
  console.log(`  Department Type totals:                ${[...source.types.values()].map((type) => `${type.name}=${type.count}`).join(', ')}`);
  console.log(`  Supplied Groups still owned by BNMS:   ${audit.groups.size}/${source.groupIds.length}`);
  console.log('  Required cardinality:                  many_to_one');
  console.log('  Idempotent re-run:                     0 creates, 0 updates');
  console.log('  Non-BNMS relevant row counts:          unchanged');
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some((argument) => argument !== '--apply')) fail('Only --apply is supported; no flag performs a dry run.');
  console.log('\n=== BNMS Organisation hierarchy import ===');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`);
  const source = readSource();
  const db = client();
  let lockClient = null;
  try {
    if (apply) lockClient = await acquireApplyLock();
    const audit = await auditTenantAndGroups(db, source);
    const model = await auditModel(db);
    const state = await loadState(db, source, model);
    const plan = makePlan(source, model, state);
    report(source, audit, model, plan);
    if (!apply) {
      console.log('\n=== DRY RUN complete: no database rows or definitions modified ===\n');
      return;
    }
    const outsideBefore = await scopeCounts(db, true);
    const preservationBefore = await snapshotApprovedDepartments(db, state, model);
    const result = await applyPlan(db, source, model, state, plan);
    console.log('\n--- Apply summary ---');
    console.log(`  Department Types created/unchanged:       ${result.types.created}/${result.types.unchanged}`);
    console.log(`  Department Type links created/unchanged:  ${result.typeRelationships.created}/${result.typeRelationships.unchanged}`);
    await verify(db, source, audit, model, outsideBefore, preservationBefore);
    console.log('\n=== Import complete ===\n');
  } finally {
    await releaseApplyLock(lockClient);
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\nERROR: ${error.message}`);
    process.exit(1);
  });
}
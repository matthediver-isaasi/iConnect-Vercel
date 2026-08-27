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
const SHEET = 'Sheet1';
const HEADERS = ['Department object', 'Organisation', 'Organisation Group uuid'];
const ROW_COUNT = 310;
const ORGANISATION_COUNT = 231;
const DEPARTMENT_COUNT = 310;
const MULTI_DEPARTMENT_ORGANISATION_COUNT = 69;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPLY_LOCK_NAME = 'bnms-organisation-hierarchy-import-v1';
const { Client: PgClient } = pg;

function fail(message) { throw new Error(message); }
function normalise(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-GB');
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
  const pair = `${normalise(row.organisationName)}::${normalise(row.departmentName)}`;
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

function readSource() {
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
  return { rows, organisations, pairs, groupIds: [...new Set(rows.map((row) => row.groupId))] };
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
  return { object, fields, nameField, definition };
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
  const edges = await fetchAll(db, 'custom_object_relationship', 'id, tenant_id, relationship_definition_id, source_record_id, target_record_id, archived_at',
    (query) => query.eq('tenant_id', TENANT_ID).eq('relationship_definition_id', model.definition.id).is('archived_at', null));
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
  return { organisations, organisationMap, records, edges, edgeBySource, edgePairs, departmentsByOrganisationAndName };
}

function makePlan(source, model, state) {
  const organisations = [...source.organisations.entries()].map(([key, row]) => {
    const existing = state.organisationMap.get(key);
    return {
      key, row, existing,
      action: !existing ? 'create' : existing.organization_group_id === row.groupId ? 'unchanged' : 'update',
    };
  });
  const departments = source.rows.map((row) => {
    const organisation = state.organisationMap.get(normalise(row.organisationName));
    const existing = organisation
      ? state.departmentsByOrganisationAndName.get(`${organisation.id}::${normalise(row.departmentName)}`)
      : null;
    const edge = existing ? state.edgeBySource.get(existing.id) : null;
    return {
      row, organisation, existing, edge,
      departmentAction: existing ? 'unchanged' : 'create',
      relationshipAction: edge ? 'unchanged' : 'create',
    };
  });
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
  console.log('\n--- Planned totals ---');
  console.log(`  Cardinality:                     ${model.definition.cardinality} -> many_to_one (${plan.cardinalityAction})`);
  console.log(`  Organisations create/update/unchanged: ${count(plan.organisations, 'action', 'create')}/${count(plan.organisations, 'action', 'update')}/${count(plan.organisations, 'action', 'unchanged')}`);
  console.log(`  Departments create/unchanged:          ${count(plan.departments, 'departmentAction', 'create')}/${count(plan.departments, 'departmentAction', 'unchanged')}`);
  console.log(`  Relationships create/unchanged:        ${count(plan.departments, 'relationshipAction', 'create')}/${count(plan.departments, 'relationshipAction', 'unchanged')}`);
  console.log('\n--- Every planned Organisation and group assignment ---');
  for (const item of plan.organisations) {
    console.log(`  Row ${item.row.sourceRow}: ${item.action.toUpperCase()} Organisation "${item.row.organisationName}" -> Group ${item.row.groupId}`);
  }
  console.log('\n--- Every planned Department relationship ---');
  for (const item of plan.departments) {
    console.log(`  Row ${item.row.sourceRow}: ${item.departmentAction.toUpperCase()} Department "${item.row.departmentName}" -> ${item.relationshipAction.toUpperCase()} link to "${item.row.organisationName}"`);
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

async function applyPlan(db, source, model, state, plan) {
  if (plan.cardinalityAction !== 'unchanged') {
    fail('Apply is blocked until migration 20260827_bnms_department_many_to_one.sql has set the relationship cardinality to many_to_one.');
  }
  const result = {
    organisations: { created: 0, updated: 0, unchanged: 0 },
    departments: { created: 0, unchanged: 0 },
    relationships: { created: 0, unchanged: 0 },
  };
  for (const item of plan.organisations) {
    if (item.action === 'unchanged') {
      result.organisations.unchanged += 1;
      continue;
    }
    if (item.action === 'update') {
      const { data, error } = await db.from('organization')
        .update({ organization_group_id: item.row.groupId })
        .eq('tenant_id', TENANT_ID).eq('id', item.existing.id)
        .select('id, tenant_id, name, organization_group_id').single();
      check(error, `Could not update Organisation "${item.row.organisationName}"`);
      if (data?.tenant_id !== TENANT_ID || data?.organization_group_id !== item.row.groupId) fail('Invalid Organisation update response.');
      state.organisationMap.set(item.key, data);
      result.organisations.updated += 1;
      continue;
    }
    const { data, error } = await db.from('organization')
      .insert({ tenant_id: TENANT_ID, name: item.row.organisationName, organization_group_id: item.row.groupId })
      .select('id, tenant_id, name, organization_group_id').single();
    check(error, `Could not create Organisation "${item.row.organisationName}"`);
    if (!data?.id || data.tenant_id !== TENANT_ID || data.organization_group_id !== item.row.groupId) fail('Invalid Organisation creation response.');
    state.organisationMap.set(item.key, data);
    result.organisations.created += 1;
  }
  for (const row of source.rows) {
    const organisation = state.organisationMap.get(normalise(row.organisationName));
    if (!organisation?.id) fail(`No resolved Organisation for row ${row.sourceRow}.`);
    const departmentKey = `${organisation.id}::${normalise(row.departmentName)}`;
    let department = state.departmentsByOrganisationAndName.get(departmentKey);
    if (!department) {
      const validated = validateCustomObjectRecordData({
        data: { name: row.departmentName }, fields: model.fields, mode: 'create',
      });
      if (!validated.ok) fail(`Row ${row.sourceRow} Department is invalid: ${validated.errors.map((item) => item.message).join('; ')}.`);
      const { data, error } = await db.from('custom_object_record').insert({
        tenant_id: TENANT_ID, custom_object_id: model.object.id, data: validated.data,
        created_by: importIdentity(row),
        updated_by: importIdentity(row),
      }).select('id, tenant_id, custom_object_id, data, created_by, archived_at').single();
      check(error, `Could not create Department at row ${row.sourceRow}`);
      if (!data?.id || data.tenant_id !== TENANT_ID || data.custom_object_id !== model.object.id) fail('Invalid Department creation response.');
      department = data;
      state.departmentsByOrganisationAndName.set(departmentKey, department);
      result.departments.created += 1;
    } else result.departments.unchanged += 1;
    const edgeKey = `${department.id}::${organisation.id}`;
    if (!state.edgePairs.has(edgeKey)) {
      const { data, error } = await db.from('custom_object_relationship').insert({
        tenant_id: TENANT_ID, relationship_definition_id: model.definition.id,
        source_record_id: department.id, target_record_id: organisation.id,
        created_by: 'system:bnms-organisation-hierarchy-import',
      }).select('id, tenant_id, relationship_definition_id, source_record_id, target_record_id, archived_at').single();
      check(error, `Could not link Department at row ${row.sourceRow}`);
      if (!data?.id || data.source_record_id !== department.id || data.target_record_id !== organisation.id) fail('Invalid relationship creation response.');
      state.edgePairs.set(edgeKey, data);
      result.relationships.created += 1;
    } else result.relationships.unchanged += 1;
  }
  return result;
}

async function verify(db, source, audit, model, outsideBefore) {
  const refreshedModel = await auditModel(db);
  if (refreshedModel.definition.cardinality !== 'many_to_one' || !refreshedModel.definition.is_required) {
    fail('Post-import relationship definition is not required many_to_one.');
  }
  const state = await loadState(db, source, refreshedModel);
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
    if (!department || !edge) failures.push(`missing Department relationship at source row ${row.sourceRow}`);
    else verifiedDepartments += 1;
  }
  if (failures.length) fail(`Post-import verification failed: ${failures.slice(0, 10).join('; ')}${failures.length > 10 ? `; and ${failures.length - 10} more` : ''}.`);
  if (sourceOrganisationIds.size !== ORGANISATION_COUNT || verifiedDepartments !== DEPARTMENT_COUNT) {
    fail('Post-import exact-count verification failed.');
  }
  if (plan.organisations.some((item) => item.action !== 'unchanged')
    || plan.departments.some((item) => item.departmentAction !== 'unchanged' || item.relationshipAction !== 'unchanged')) {
    fail('Idempotency check failed: a second run would still write hierarchy data.');
  }
  const outsideAfter = await scopeCounts(db, true);
  if (digest(outsideBefore) !== digest(outsideAfter)) fail('Tenant-isolation verification failed: non-BNMS relevant row counts changed.');
  console.log('\n--- Post-import verification ---');
  console.log(`  Organisations exactly resolved:        ${sourceOrganisationIds.size}/${ORGANISATION_COUNT}`);
  console.log(`  Organisation-to-Group assignments:     ${sourceOrganisationIds.size}/${ORGANISATION_COUNT}`);
  console.log(`  Departments exactly resolved:          ${verifiedDepartments}/${DEPARTMENT_COUNT}`);
  console.log(`  Department-to-Organisation links:      ${verifiedDepartments}/${DEPARTMENT_COUNT}`);
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
    const result = await applyPlan(db, source, model, state, plan);
    console.log('\n--- Apply summary ---');
    console.log(`  Organisations created/updated/unchanged: ${result.organisations.created}/${result.organisations.updated}/${result.organisations.unchanged}`);
    console.log(`  Departments created/unchanged:           ${result.departments.created}/${result.departments.unchanged}`);
    console.log(`  Relationships created/unchanged:         ${result.relationships.created}/${result.relationships.unchanged}`);
    await verify(db, source, audit, model, outsideBefore);
    console.log('\n=== Import complete ===\n');
  } finally {
    await releaseApplyLock(lockClient);
  }
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
});
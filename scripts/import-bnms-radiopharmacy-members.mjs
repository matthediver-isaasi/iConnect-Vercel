#!/usr/bin/env node
/**
 * Dry-run-first, destination-only BNMS Radiopharmacy Member importer.
 *
 * Usage:
 *   node scripts/import-bnms-radiopharmacy-members.mjs
 *   node scripts/import-bnms-radiopharmacy-members.mjs --apply
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'attached_assets', 'Radiopharmacy_contacts_(1)_1787897159306.xlsx');
export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const SHARON_MEMBER_ID = '3d291826-13d8-4fc1-9221-7627fc45830a';
export const SHEET = 'Sheet1';
export const HEADERS = ['Department UUID', 'First name', 'Last name', 'Email address'];
export const ROW_COUNT = 55;
export const EXPECTED_FILE_SHA256 = '57ec1407ada303ff4b6629c59a296c75705f70d31abb791970953df88cf41470';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const IMPORT_ACTOR = 'system:bnms-radiopharmacy-member-import';

export function fail(message) { throw new Error(message); }
function check(error, context) { if (error) fail(`${context}: ${error.message}`); }
function emailKey(value) { return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-GB'); }
function text(value) { return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim(); }

export function deterministicMemberId(email) {
  const hex = createHash('sha256').update(`bnms-radiopharmacy-member:${emailKey(email)}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function readSource(file = FILE) {
  const bytes = readFileSync(file);
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (fingerprint !== EXPECTED_FILE_SHA256) {
    fail(`Workbook fingerprint mismatch; expected ${EXPECTED_FILE_SHA256}, found ${fingerprint}.`);
  }
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== SHEET) {
    fail(`Workbook must contain only ${SHEET}; found ${workbook.SheetNames.join(', ') || '(none)'}.`);
  }
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[SHEET], { header: 1, defval: null, raw: false });
  const actualHeaders = (grid[0] || []).map(text);
  if (actualHeaders.length !== HEADERS.length
    || actualHeaders.some((value, index) => value !== HEADERS[index])) {
    fail(`${SHEET} headers must be exactly: ${HEADERS.join(' | ')}. Found: ${actualHeaders.join(' | ') || '(none)'}.`);
  }
  const rows = [];
  for (let index = 1; index < grid.length; index += 1) {
    const values = HEADERS.map((_, column) => text(grid[index]?.[column]));
    if (values.every((value) => !value)) continue;
    const missing = HEADERS.filter((_, column) => !values[column]);
    if (missing.length) fail(`${SHEET} row ${index + 1} is missing: ${missing.join(', ')}.`);
    const departmentId = values[0].toLowerCase();
    const email = emailKey(values[3]);
    if (!UUID_RE.test(departmentId)) fail(`${SHEET} row ${index + 1} has invalid Department UUID "${values[0]}".`);
    if (!EMAIL_RE.test(email)) fail(`${SHEET} row ${index + 1} has invalid email "${values[3]}".`);
    rows.push({
      sourceRow: index + 1,
      departmentId,
      firstName: values[1],
      lastName: values[2],
      email,
      memberId: deterministicMemberId(email),
    });
  }
  if (rows.length !== ROW_COUNT) fail(`${SHEET} must contain ${ROW_COUNT} populated rows; found ${rows.length}.`);
  for (const [label, key] of [['Department UUID', 'departmentId'], ['email', 'email']]) {
    const seen = new Map();
    for (const row of rows) {
      if (seen.has(row[key])) fail(`Duplicate ${label} at rows ${seen.get(row[key])} and ${row.sourceRow}.`);
      seen.set(row[key], row.sourceRow);
    }
  }
  return { rows, fingerprint };
}

function destinationClient() {
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required; SOURCE and bare SUPABASE credentials are forbidden.');
  }
  return createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
    auth: { persistSession: false },
  });
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

async function auditTenantAndModel(db) {
  const { data: tenant, error: tenantError } = await db.from('tenant')
    .select('id, name').eq('id', TENANT_ID).maybeSingle();
  check(tenantError, 'Could not resolve pinned BNMS tenant');
  if (tenant?.id !== TENANT_ID || !/\bbnms\b|british nuclear medicine society/i.test(tenant.name || '')) {
    fail(`Pinned tenant is not BNMS (${tenant?.name || 'not found'}).`);
  }
  const objects = await fetchAll(db, 'custom_object_definition', 'id, tenant_id, object_key, status',
    (query) => query.eq('tenant_id', TENANT_ID).eq('object_key', 'org_department').eq('status', 'active'));
  if (objects.length !== 1) fail(`Expected exactly one active BNMS Department object; found ${objects.length}.`);
  const object = objects[0];
  const definitions = await fetchAll(db, 'custom_object_relationship_definition',
    'id, tenant_id, relationship_key, source_kind, source_custom_object_id, target_kind, target_custom_object_id, cardinality, is_required, status, configuration',
    (query) => query.eq('tenant_id', TENANT_ID).eq('status', 'active'));
  const parents = definitions.filter((row) => row.relationship_key === 'organisation'
    && row.source_kind === 'custom_object' && row.source_custom_object_id === object.id
    && row.target_kind === 'organization' && row.target_custom_object_id === null && row.is_required);
  if (parents.length !== 1 || parents[0].cardinality !== 'many_to_one') {
    fail(`Expected exactly one active required many-to-one BNMS Department-to-Organisation definition; found ${parents.length}.`);
  }
  const members = definitions.filter((row) => row.relationship_key === 'members'
    && row.source_kind === 'custom_object' && row.source_custom_object_id === object.id
    && row.target_kind === 'member' && row.target_custom_object_id === null);
  if (members.length !== 1 || members[0].cardinality !== 'one_to_many' || members[0].is_required) {
    fail(`Expected exactly one active optional one-to-many BNMS Department-to-Member definition; found ${members.length}.`);
  }
  const picker = members[0].configuration?.picker_scope;
  if (picker?.via_relationship_key !== 'organisation' || picker?.routed_core_field !== 'organization_id') {
    fail('BNMS Department-to-Member picker routing does not match the approved Organisation invariant.');
  }
  return { tenant, object, parentDefinition: parents[0], memberDefinition: members[0] };
}

async function loadState(db, source, model) {
  const departmentIds = source.rows.map((row) => row.departmentId);
  const departments = await fetchAll(db, 'custom_object_record',
    'id, tenant_id, custom_object_id, archived_at',
    (query) => query.eq('tenant_id', TENANT_ID).eq('custom_object_id', model.object.id).in('id', departmentIds));
  if (departments.length !== ROW_COUNT || departments.some((row) => row.archived_at !== null)) {
    fail(`All ${ROW_COUNT} supplied Department UUIDs must resolve to active BNMS Department records; found ${departments.filter((row) => !row.archived_at).length}.`);
  }
  const parentEdges = await fetchAll(db, 'custom_object_relationship',
    'id, tenant_id, relationship_definition_id, source_record_id, target_record_id, archived_at',
    (query) => query.eq('tenant_id', TENANT_ID).eq('relationship_definition_id', model.parentDefinition.id)
      .in('source_record_id', departmentIds));
  const activeParentByDepartment = new Map();
  for (const departmentId of departmentIds) {
    const matches = parentEdges.filter((row) => row.source_record_id === departmentId && row.archived_at === null);
    if (matches.length !== 1) fail(`Department ${departmentId} must have exactly one active Organisation edge; found ${matches.length}.`);
    activeParentByDepartment.set(departmentId, matches[0]);
  }
  const organisationIds = [...new Set([...activeParentByDepartment.values()].map((row) => row.target_record_id))];
  const organisations = await fetchAll(db, 'organization', 'id, tenant_id, name, status',
    (query) => query.eq('tenant_id', TENANT_ID).in('id', organisationIds));
  const organizationById = new Map(organisations.map((row) => [row.id, row]));
  const invalidOrganizations = organisationIds.filter((id) => {
    const row = organizationById.get(id);
    return !row || row.tenant_id !== TENANT_ID || row.status === 'archived' || row.status === 'inactive';
  });
  if (invalidOrganizations.length) fail(`${invalidOrganizations.length} resolved Organisations are missing, inactive, archived, or outside BNMS.`);

  const allMembers = await fetchAll(db, 'member',
    'id, tenant_id, email, first_name, last_name, organization_id, login_enabled, show_in_directory, is_guest',
    (query) => query.eq('tenant_id', TENANT_ID));
  if (![1, 56].includes(allMembers.length)) fail(`BNMS must contain exactly 1 pre-import Member or 56 post-import Members; found ${allMembers.length}.`);
  const sharon = allMembers.find((row) => row.id === SHARON_MEMBER_ID);
  if (!sharon) fail('Sharon recovery Member is missing; import aborted.');
  const byEmail = new Map();
  for (const member of allMembers) {
    const key = emailKey(member.email);
    if (byEmail.has(key)) fail(`BNMS has duplicate normalized Member email "${key}".`);
    byEmail.set(key, member);
  }
  const memberEdges = await fetchAll(db, 'custom_object_relationship',
    'id, tenant_id, relationship_definition_id, source_record_id, target_record_id, archived_at',
    (query) => query.eq('tenant_id', TENANT_ID).eq('relationship_definition_id', model.memberDefinition.id)
      .in('source_record_id', departmentIds));
  return {
    departments,
    activeParentByDepartment,
    organizationById,
    allMembers,
    byEmail,
    memberEdges,
  };
}

function exactMember(member, desired) {
  return member.id === desired.memberId
    && emailKey(member.email) === desired.email
    && member.first_name === desired.firstName
    && member.last_name === desired.lastName
    && member.organization_id === desired.organizationId
    && member.login_enabled === true
    && member.show_in_directory === true
    && member.is_guest === false;
}

export function makePlan(source, state, model) {
  const members = [];
  const edges = [];
  for (const row of source.rows) {
    const organizationId = state.activeParentByDepartment.get(row.departmentId)?.target_record_id;
    if (!organizationId || !state.organizationById.has(organizationId)) fail(`No valid Organisation resolved for row ${row.sourceRow}.`);
    const desired = { ...row, organizationId };
    const existing = state.byEmail.get(row.email);
    if (existing && !exactMember(existing, desired)) {
      fail(`Row ${row.sourceRow} email already belongs to a non-exact BNMS Member; existing Members are never updated.`);
    }
    const memberId = existing?.id || row.memberId;
    const related = state.memberEdges.filter((edge) => edge.target_record_id === memberId);
    const exactActive = related.filter((edge) => edge.archived_at === null && edge.source_record_id === row.departmentId);
    const conflicts = related.filter((edge) => edge.archived_at !== null || edge.source_record_id !== row.departmentId);
    if (conflicts.length || exactActive.length > 1) {
      fail(`Row ${row.sourceRow} has conflicting active or archived Department-to-Member relationship history.`);
    }
    members.push({ ...desired, existing, action: existing ? 'unchanged' : 'create' });
    edges.push({
      sourceRow: row.sourceRow,
      departmentId: row.departmentId,
      memberId,
      existing: exactActive[0] || null,
      action: exactActive.length === 1 ? 'unchanged' : 'create',
      definitionId: model.memberDefinition.id,
    });
  }
  if (state.allMembers.length === 1
    && (members.some((row) => row.action !== 'create') || edges.some((row) => row.action !== 'create'))) {
    fail('The pre-import BNMS state is partial or unexpected.');
  }
  if (state.allMembers.length === 56 && members.some((row) => row.action !== 'unchanged')) {
    fail('BNMS already has 56 Members but they are not the exact imported Member set.');
  }
  return { members, edges };
}

function count(rows, action) { return rows.filter((row) => row.action === action).length; }
function report(source, model, state, plan) {
  console.log('\n--- Validated source and destination ---');
  console.log(`  Workbook SHA-256:                 ${source.fingerprint}`);
  console.log(`  Sheet / exact rows:               ${SHEET} / ${source.rows.length}`);
  console.log(`  Tenant:                           ${model.tenant.name} (${TENANT_ID})`);
  console.log(`  Active Departments:               ${state.departments.length}/${ROW_COUNT}`);
  console.log(`  Exact Organisation parent edges:  ${state.activeParentByDepartment.size}/${ROW_COUNT}`);
  console.log(`  Resolved Organisations:           ${state.organizationById.size}`);
  console.log(`  Existing BNMS Members:            ${state.allMembers.length}`);
  console.log('\n--- Planned totals ---');
  console.log(`  Members create/unchanged:         ${count(plan.members, 'create')}/${count(plan.members, 'unchanged')}`);
  console.log(`  Department edges create/unchanged:${count(plan.edges, 'create')}/${count(plan.edges, 'unchanged')}`);
  console.log(`  Expected final BNMS Members:      ${state.allMembers.length + count(plan.members, 'create')}/56`);
  console.log('\n--- Exact Member assignments ---');
  for (const item of plan.members) {
    console.log(`  Row ${item.sourceRow}: ${item.action.toUpperCase()} ${item.email} -> Organisation ${item.organizationId} -> Department ${item.departmentId}`);
  }
}

async function snapshotOutsideCounts(db) {
  const result = {};
  for (const table of ['member', 'custom_object_relationship']) {
    const { count: total, error } = await db.from(table).select('id', { count: 'exact', head: true })
      .neq('tenant_id', TENANT_ID);
    check(error, `Could not snapshot non-BNMS ${table}`);
    result[table] = total;
  }
  return result;
}

async function applyPlan(db, plan) {
  const members = plan.members.filter((row) => row.action === 'create').map((row) => ({
    id: row.memberId,
    tenant_id: TENANT_ID,
    organization_id: row.organizationId,
    email: row.email,
    first_name: row.firstName,
    last_name: row.lastName,
    login_enabled: true,
    show_in_directory: true,
    is_guest: false,
  }));
  if (members.length) {
    const { data, error } = await db.from('member').insert(members)
      .select('id, tenant_id, organization_id, email, first_name, last_name, login_enabled, show_in_directory, is_guest');
    check(error, 'Atomic Member batch insert failed');
    if ((data || []).length !== members.length) fail('Member batch insert returned an unexpected row count.');
  }
  const edges = plan.edges.filter((row) => row.action === 'create').map((row) => ({
    tenant_id: TENANT_ID,
    relationship_definition_id: row.definitionId,
    source_record_id: row.departmentId,
    target_record_id: row.memberId,
    created_by: IMPORT_ACTOR,
  }));
  if (edges.length) {
    const { data, error } = await db.from('custom_object_relationship').insert(edges)
      .select('id, tenant_id, relationship_definition_id, source_record_id, target_record_id, archived_at');
    check(error, 'Atomic Department relationship batch insert failed');
    if ((data || []).length !== edges.length) fail('Relationship batch insert returned an unexpected row count.');
  }
  return { members: members.length, edges: edges.length };
}

async function verify(db, source, model, outsideBefore) {
  const state = await loadState(db, source, model);
  const plan = makePlan(source, state, model);
  if (state.allMembers.length !== 56
    || plan.members.some((row) => row.action !== 'unchanged')
    || plan.edges.some((row) => row.action !== 'unchanged')) {
    fail('Post-import verification failed or a second run would still write.');
  }
  const outsideAfter = await snapshotOutsideCounts(db);
  if (JSON.stringify(outsideBefore) !== JSON.stringify(outsideAfter)) {
    fail('Non-BNMS Member or relationship counts changed during apply.');
  }
  console.log('\n--- Post-import verification ---');
  console.log('  Exact imported Members:           55/55');
  console.log('  Portal login enabled:             55/55');
  console.log('  Directory visible:                55/55');
  console.log('  Organisation assignments:         55/55');
  console.log('  Department relationships:         55/55');
  console.log('  Total BNMS Members incl. Sharon:  56/56');
  console.log('  Idempotent re-run:                0 writes');
  console.log('  Non-BNMS relevant row counts:     unchanged');
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some((argument) => argument !== '--apply')) {
    fail('Only --apply is supported; no flag performs a dry run.');
  }
  console.log('\n=== BNMS Radiopharmacy Member import ===');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`);
  const source = readSource();
  const db = destinationClient();
  const model = await auditTenantAndModel(db);
  const state = await loadState(db, source, model);
  const plan = makePlan(source, state, model);
  report(source, model, state, plan);
  if (!apply) {
    console.log('\n=== DRY RUN complete: no database rows modified ===\n');
    return;
  }
  const outsideBefore = await snapshotOutsideCounts(db);
  const result = await applyPlan(db, plan);
  console.log(`\nApplied: ${result.members} Members and ${result.edges} Department relationships.`);
  await verify(db, source, model, outsideBefore);
  console.log('\n=== Import complete ===\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nERROR: ${error.message}`);
    process.exit(1);
  });
}

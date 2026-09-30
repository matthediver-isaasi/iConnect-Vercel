#!/usr/bin/env node
/**
 * Dry-run-first import of the pinned BNMS honorary-member CSV.
 *
 * Usage:
 *   node scripts/import-bnms-honorary-members.mjs
 *   node scripts/import-bnms-honorary-members.mjs --apply
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import {
  TENANT_ID, applyPlan, clean, emailKey, parseBritishDate, transformed,
  validateReturnedRows, verifyOrCompensate,
} from './import-bnms-direct-debit-members.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'attached_assets', 'Honoray_members_to_import_updated_31.08.26_1788202206478.csv');
export const EXPECTED_FILE_SHA256 = '2ded6e812d2c62f30d26d3e0fbc7232081dbaeada047acea518614775fd261f2';
export const ROW_COUNT = 21;
export const COLUMN_COUNT = 23;
export const ASSIGNMENT_COUNTS = Object.freeze({ organization: 2, department: 5, none: 14 });
export const HEADERS = Object.freeze([
  'YM Web Site Member ID', 'Member Since', 'YM Date Membership Expires',
  'YM Membership type', 'Member class', 'Membership status', 'First Name',
  'Last Name', 'Title', 'Email', 'Alternative email address',
  'Invoice address line 1', 'Invoice address line 2', 'Invoice city',
  'Invoice county/state', 'Invoice post/zip code', 'Invoice country', 'Landline',
  'Mobile', 'Organisation UUID', 'Department UUID', 'Occupation', 'Qualifications',
]);
export const CORE_MAPPINGS = Object.freeze([
  { column: 1, destination: 'created_on', transform: 'date' },
  { column: 6, destination: 'first_name' },
  { column: 7, destination: 'last_name' },
  { column: 9, destination: 'email', transform: 'email' },
  { column: 17, destination: 'landline' },
  { column: 18, destination: 'mobile' },
]);
export const CUSTOM_MAPPINGS = Object.freeze([
  ['50d7b71c-29b0-4d4c-a817-f39edf35f2e0', 0, 'ym_web_site_member_id', 'YM Web Site Member ID', 'text'],
  ['2f04cda8-33f9-4df4-bcd5-e7150e4ca9ae', 2, 'ym_date_membership_expires', 'YM Date Membership Expires', 'text', 'validated-date'],
  ['40bdb74f-e8e0-4ad1-9760-b1128256a752', 3, 'ym_membership_type', 'YM Membership type', 'dropdown'],
  ['87f120ff-92e6-4d52-944b-9ba9d7b1fac0', 4, 'member_class', 'Member class', 'dropdown'],
  ['388e1dfe-d917-4317-933a-0319542a7d92', 5, 'membership_status', 'Membership status', 'dropdown'],
  ['4f2e504c-1663-4dd8-a486-274159834320', 8, 'title', 'Title', 'dropdown'],
  ['b3d6ddbe-57c3-45a8-8f03-316f90b3dfbd', 10, 'alternative_email_address', 'Alternative email address', 'email'],
  ['764c4892-c12b-41bd-a9af-10a6a543f4fe', 11, 'invoice_address_line_1', 'Invoice address line 1', 'text'],
  ['61796f97-f8dc-42b1-8981-49853a1a60b5', 12, 'invoice_address_line_2', 'Invoice address line 2', 'text'],
  ['94c2d085-6cb8-41e7-a634-e6a6735b7e3e', 13, 'invoice_city', 'Invoice city', 'text'],
  ['fbc60ae4-c394-4f5e-b76a-0351499d0cf3', 14, 'invoice_county_state', 'Invoice county/state', 'text'],
  ['8983dc97-a0ed-4d81-9932-45900bca9b0b', 15, 'invoice_postcode', 'Invoice post/zip code', 'text'],
  ['6dcef4da-8c74-49fd-9d64-98bbb088af28', 16, 'invoice_country', 'Invoice country', 'country'],
  ['1c84695f-e8f8-4afd-b4be-e54f5f540a26', 21, 'occupation', 'Occupation', 'dropdown'],
  ['5a12aae9-d754-45ce-ac47-a97109a690e2', 22, 'qualifications', 'Qualifications', 'textarea'],
].map(([id, column, name, label, type, transform]) => ({ id, column, name, label, type, transform })));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message) => { throw new Error(message); };
const check = (error, context) => { if (error) fail(`${context}: ${error.message}`); };

export function parseSourceBytes(bytes, { verifyFingerprint = true } = {}) {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (verifyFingerprint && fingerprint !== EXPECTED_FILE_SHA256) {
    fail(`CSV fingerprint mismatch; expected ${EXPECTED_FILE_SHA256}, found ${fingerprint}.`);
  }
  const grid = parse(bytes, { bom: true, relax_column_count: false, skip_empty_lines: false });
  if (!grid.length || grid[0].length !== COLUMN_COUNT
    || grid[0].some((value, index) => clean(value) !== HEADERS[index])) {
    fail(`CSV must have the exact ${COLUMN_COUNT}-column positional header contract.`);
  }
  const rows = grid.slice(1).map((input, index) => {
    if (input.length !== COLUMN_COUNT) fail(`CSV row ${index + 2} must contain exactly ${COLUMN_COUNT} columns; found ${input.length}.`);
    const values = input.map(clean);
    if (!values.some(Boolean)) return null;
    const sourceRow = index + 2;
    if (!values[0]) fail(`CSV row ${sourceRow} has blank YM Web Site Member ID.`);
    if (!values[6] || !values[7]) fail(`CSV row ${sourceRow} has a blank required name.`);
    if (!values[9] || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values[9])) fail(`CSV row ${sourceRow} has invalid Email "${values[9]}".`);
    parseBritishDate(values[1], `Member Since at row ${sourceRow}`);
    if (values[2]) fail(`CSV row ${sourceRow} unexpectedly supplies YM Date Membership Expires.`);
    for (const column of [19, 20]) {
      if (values[column] && !UUID_RE.test(values[column])) fail(`CSV row ${sourceRow} has invalid UUID in "${HEADERS[column]}".`);
    }
    if (values[19] && values[20]) fail(`CSV row ${sourceRow} supplies both Organisation and Department UUID.`);
    return { sourceRow, email: emailKey(values[9]), legacyId: values[0], values };
  }).filter(Boolean);
  if (rows.length !== ROW_COUNT) fail(`CSV must contain exactly ${ROW_COUNT} populated rows; found ${rows.length}.`);
  for (const [key, label] of [['email', 'normalized Email'], ['legacyId', 'YM Web Site Member ID']]) {
    const seen = new Map();
    for (const row of rows) {
      if (seen.has(row[key])) fail(`Duplicate ${label} at rows ${seen.get(row[key])} and ${row.sourceRow}.`);
      seen.set(row[key], row.sourceRow);
    }
  }
  const constants = [[3, 'Honorary Membership'], [4, 'Honorary'], [5, 'Active']];
  for (const [column, expected] of constants) {
    const actual = [...new Set(rows.map((row) => row.values[column]))];
    if (actual.length !== 1 || actual[0] !== expected) fail(`${HEADERS[column]} values drifted: ${actual.join(', ')}.`);
  }
  const counts = {
    organization: rows.filter((row) => row.values[19]).length,
    department: rows.filter((row) => row.values[20]).length,
    none: rows.filter((row) => !row.values[19] && !row.values[20]).length,
  };
  if (Object.keys(counts).some((key) => counts[key] !== ASSIGNMENT_COUNTS[key])) fail(`Hierarchy source counts drifted: ${JSON.stringify(counts)}.`);
  return { rows, fingerprint, counts };
}
export function readSource(file = FILE) { return parseSourceBytes(readFileSync(file)); }

export function auditMappings(fields, source) {
  return CUSTOM_MAPPINGS.map((contract) => {
    const candidates = fields.filter((field) => field.id === contract.id || field.name === contract.name || field.label === contract.label);
    if (candidates.length !== 1) fail(`Expected one unambiguous live field for "${contract.label}"; found ${candidates.length}.`);
    const field = candidates[0];
    if (field.id !== contract.id || field.tenant_id !== TENANT_ID || field.entity_scope !== 'member'
      || field.name !== contract.name || field.label !== contract.label
      || field.field_type !== contract.type || field.is_active !== true) fail(`Live field contract drifted for "${contract.label}".`);
    const requested = [...new Set(source.rows.map((row) => row.values[contract.column]).filter(Boolean))];
    if (contract.type === 'dropdown') {
      const allowed = new Set((field.options || []).flatMap((option) => [clean(option?.value), clean(option?.label)]).filter(Boolean));
      const unsupported = requested.filter((value) => !allowed.has(value));
      if (unsupported.length) fail(`Unsupported "${contract.label}" value(s): ${unsupported.join(', ')}.`);
    } else if (field.options != null) fail(`Field "${contract.label}" unexpectedly has controlled options.`);
    return { ...contract, requested };
  });
}

function uniqueById(rows, label) {
  const result = new Map();
  for (const row of rows || []) {
    if (result.has(row.id)) fail(`Duplicate destination ${label} id ${row.id}.`);
    result.set(row.id, row);
  }
  return result;
}
export function auditHierarchy(source, state) {
  const groups = uniqueById(state.groups, 'Organisation Group');
  const organizations = uniqueById(state.organizations, 'Organisation');
  const departments = uniqueById(state.departments, 'Department');
  const definitions = state.relationshipDefinitions || [];
  const parentDefs = definitions.filter((item) => item.relationship_key === 'organisation' && item.tenant_id === TENANT_ID
    && item.source_kind === 'custom_object' && item.target_kind === 'organization'
    && item.cardinality === 'many_to_one' && item.is_required === true && item.status === 'active');
  const memberDefs = definitions.filter((item) => item.relationship_key === 'members' && item.tenant_id === TENANT_ID
    && item.source_kind === 'custom_object' && item.target_kind === 'member'
    && item.cardinality === 'many_to_many' && item.is_required === false && item.status === 'active');
  if (parentDefs.length !== 1 || memberDefs.length !== 1 || parentDefs[0].source_custom_object_id !== memberDefs[0].source_custom_object_id) {
    fail(`Department relationship model requires exactly one compatible "organisation" and "members" definition; found ${parentDefs.length}/${memberDefs.length}.`);
  }
  const organizationIds = new Set(source.rows.map((row) => row.values[19]).filter(Boolean));
  const departmentIds = new Set(source.rows.map((row) => row.values[20]).filter(Boolean));
  const organizationChains = [];
  const departmentChains = [];
  const departmentParents = new Map();
  for (const row of source.rows.filter((item) => item.values[19])) {
    const organization = organizations.get(row.values[19]);
    if (organization?.tenant_id !== TENANT_ID) fail(`Row ${row.sourceRow}: Organisation ${row.values[19]} is missing or outside BNMS.`);
    const group = groups.get(organization.organization_group_id);
    if (group?.tenant_id !== TENANT_ID) fail(`Row ${row.sourceRow}: Organisation ${organization.id} has no valid BNMS Organisation Group.`);
    organizationChains.push({ sourceRow: row.sourceRow, organizationId: organization.id, groupId: group.id });
  }
  for (const row of source.rows.filter((item) => item.values[20])) {
    const department = departments.get(row.values[20]);
    if (department?.tenant_id !== TENANT_ID || department.archived_at != null
      || department.custom_object_id !== memberDefs[0].source_custom_object_id) {
      fail(`Row ${row.sourceRow}: Department ${row.values[20]} is missing, archived, outside BNMS, or belongs to the wrong object.`);
    }
    const edges = (state.parentEdges || []).filter((edge) => edge.archived_at == null
      && edge.relationship_definition_id === parentDefs[0].id && edge.source_record_id === department.id);
    const organization = edges.length === 1 ? organizations.get(edges[0].target_record_id) : null;
    if (edges.length !== 1 || edges[0].tenant_id !== TENANT_ID || organization?.tenant_id !== TENANT_ID) {
      fail(`Row ${row.sourceRow}: Department ${department.id} must have exactly one active BNMS Organisation parent; found ${edges.length}.`);
    }
    const group = groups.get(organization.organization_group_id);
    if (group?.tenant_id !== TENANT_ID) fail(`Row ${row.sourceRow}: Department ${department.id} -> Organisation ${organization.id} has no valid BNMS Organisation Group.`);
    departmentParents.set(department.id, organization.id);
    departmentChains.push({ sourceRow: row.sourceRow, departmentId: department.id, organizationId: organization.id, groupId: group.id });
  }
  return { organizationIds, departmentIds, organizationChains, departmentChains, departmentParents, memberDefinition: memberDefs[0] };
}

const sameValue = (actual, desired) => clean(actual) === clean(desired);
export function makePlan(source, state, mappings, hierarchy) {
  const sourceEmails = new Set(source.rows.map((row) => row.email));
  const membersByEmail = new Map();
  for (const member of state.members || []) {
    const key = emailKey(member.email);
    if (!sourceEmails.has(key)) continue;
    if (membersByEmail.has(key)) fail(`Ambiguous destination Member email "${key}".`);
    if (member.tenant_id !== TENANT_ID) fail(`Email "${key}" resolved outside BNMS.`);
    membersByEmail.set(key, member);
  }
  const preferenceGroups = new Map();
  for (const value of state.preferenceValues || []) {
    const key = `${value.member_id}|${value.field_id}`;
    preferenceGroups.set(key, [...(preferenceGroups.get(key) || []), value]);
  }
  return { items: source.rows.map((row) => {
    const member = membersByEmail.get(row.email) || null;
    const patch = {};
    for (const mapping of CORE_MAPPINGS) {
      const raw = row.values[mapping.column];
      if (!raw) continue;
      const desired = transformed(raw, mapping.transform, `${mapping.destination} at row ${row.sourceRow}`);
      const matches = mapping.transform === 'date'
        ? clean(member?.[mapping.destination]).slice(0, 10) === desired
        : member && sameValue(member[mapping.destination], desired);
      if (!matches) patch[mapping.destination] = desired;
    }
    // Model the desired relationships as a set even though this pinned source
    // has a single Department column.
    const departmentIds = [...new Set([row.values[20]].filter(Boolean))];
    const departmentId = departmentIds[0] || null;
    const organizationId = row.values[19] || (departmentId ? hierarchy.departmentParents.get(departmentId) : null);
    if (organizationId && member?.organization_id !== organizationId) patch.organization_id = organizationId;
    const preferences = mappings.flatMap((mapping) => {
      const raw = row.values[mapping.column];
      if (!raw) return [];
      const desired = String(transformed(raw, mapping.transform, `${mapping.label} at row ${row.sourceRow}`));
      const existing = member ? (preferenceGroups.get(`${member.id}|${mapping.id}`) || []) : [];
      if (existing.length > 1) fail(`Duplicate preference values for "${row.email}", field "${mapping.label}".`);
      return [{ mapping, desired, existing: existing[0] || null, action: !existing.length ? 'insert' : sameValue(existing[0].value, desired) ? 'unchanged' : 'update' }];
    });
    const relatedEdges = member ? (state.memberEdges || []).filter((edge) => edge.target_record_id === member.id
      && edge.relationship_definition_id === hierarchy.memberDefinition.id && edge.archived_at == null) : [];
    for (const edge of relatedEdges) {
      if (edge.tenant_id != null && edge.tenant_id !== TENANT_ID) {
        fail(`Member "${row.email}" has an active Department edge outside BNMS.`);
      }
    }
    const activeByDepartment = new Map();
    for (const edge of relatedEdges) {
      const matches = activeByDepartment.get(edge.source_record_id) || [];
      matches.push(edge);
      activeByDepartment.set(edge.source_record_id, matches);
      if (matches.length > 1) fail(`Member "${row.email}" has duplicate active Department member edges for ${edge.source_record_id}.`);
    }
    const exactEdges = departmentIds.flatMap((id) => activeByDepartment.get(id) || []);
    // A legacy Department column is additive under the many-to-many model.
    // Preserve every other active membership and only ensure the supplied one.
    const conflictingEdges = [];
    const edgeAction = departmentId ? (exactEdges.length ? 'unchanged' : 'insert') : 'none';
    return {
      row, member, patch, action: member ? (Object.keys(patch).length ? 'update' : 'unchanged') : 'insert',
      preferences, departmentId, departmentIds,
      departmentAssignmentMode: organizationId ? 'ensure' : 'preserve',
      edgeAction, conflictingEdges, exactEdges, activeDepartmentEdges: relatedEdges,
    };
  }) };
}
export const noReferenceRows = (source) => source.rows.filter((row) => !row.values[19] && !row.values[20])
  .map((row) => ({ sourceRow: row.sourceRow, email: row.email }));

function destinationClient() {
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required; source and bare Supabase credentials are forbidden.');
  return createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
}
async function fetchAll(db, table, columns, configure = (query) => query) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await configure(db.from(table).select(columns).order('id').range(from, from + 499));
    check(error, `Could not read ${table}`); rows.push(...(data || []));
    if ((data || []).length < 500) return rows;
  }
}
export async function loadState(db, source) {
  const departmentIds = [...new Set(source.rows.map((row) => row.values[20]).filter(Boolean))];
  const [tenantResult, fields, groups, organizations, departments, definitions, parentEdges, allMembers] = await Promise.all([
    db.from('tenant').select('id,name').eq('id', TENANT_ID).maybeSingle(),
    fetchAll(db, 'preference_field', 'id,tenant_id,name,label,field_type,entity_scope,is_active,options', (q) => q.eq('tenant_id', TENANT_ID).eq('entity_scope', 'member')),
    fetchAll(db, 'organization_group', 'id,tenant_id,name', (q) => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'organization', 'id,tenant_id,name,organization_group_id', (q) => q.eq('tenant_id', TENANT_ID)),
    departmentIds.length ? fetchAll(db, 'custom_object_record', 'id,tenant_id,custom_object_id,archived_at', (q) => q.in('id', departmentIds)) : [],
    fetchAll(db, 'custom_object_relationship_definition', 'id,tenant_id,relationship_key,source_kind,source_custom_object_id,target_kind,target_custom_object_id,cardinality,is_required,status', (q) => q.eq('tenant_id', TENANT_ID)),
    departmentIds.length ? fetchAll(db, 'custom_object_relationship', 'id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at,archived_by', (q) => q.in('source_record_id', departmentIds)) : [],
    fetchAll(db, 'member', 'id,tenant_id,email,first_name,last_name,created_on,landline,mobile,organization_id', (q) => q.eq('tenant_id', TENANT_ID)),
  ]);
  check(tenantResult.error, 'Could not resolve pinned BNMS tenant');
  if (tenantResult.data?.id !== TENANT_ID || !/\bbnms\b|british nuclear medicine society/i.test(tenantResult.data?.name || '')) fail('Pinned destination is not BNMS.');
  const sourceEmails = new Set(source.rows.map((row) => row.email));
  const members = allMembers.filter((member) => sourceEmails.has(emailKey(member.email)));
  const memberIds = members.map((member) => member.id);
  const [preferenceValues, memberEdges] = await Promise.all([
    memberIds.length ? fetchAll(db, 'member_preference_value', 'id,member_id,field_id,value', (q) => q.in('member_id', memberIds)) : [],
    memberIds.length ? fetchAll(db, 'custom_object_relationship', 'id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at,archived_by', (q) => q.in('target_record_id', memberIds)) : [],
  ]);
  return { tenant: tenantResult.data, fields, groups, organizations, departments, relationshipDefinitions: definitions, parentEdges, members, preferenceValues, memberEdges };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const digest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
async function preservationSnapshot(db, source, mappings, hierarchy, originalIds = null) {
  const allMembers = await fetchAll(db, 'member', '*', (q) => q.eq('tenant_id', TENANT_ID));
  const emails = new Set(source.rows.map((row) => row.email));
  const sourceMembers = allMembers.filter((member) => emails.has(emailKey(member.email)));
  const currentIds = new Set(sourceMembers.map((member) => member.id));
  const protectedIds = originalIds || currentIds;
  const fieldIds = mappings.map((mapping) => mapping.id);
  const [sourcePrefs, targetPrefs, edges] = await Promise.all([
    protectedIds.size ? fetchAll(db, 'member_preference_value', '*', (q) => q.in('member_id', [...protectedIds])) : [],
    fetchAll(db, 'member_preference_value', '*', (q) => q.in('field_id', fieldIds)),
    protectedIds.size ? fetchAll(db, 'custom_object_relationship', '*', (q) => q.in('target_record_id', [...protectedIds])) : [],
  ]);
  const managed = new Set([...CORE_MAPPINGS.map((item) => item.destination), 'organization_id', 'updated_at']);
  const managedRelationshipMemberIds = new Set(source.rows.filter((row) => row.values[19] || row.values[20])
    .map((row) => sourceMembers.find((member) => emailKey(member.email) === row.email)?.id).filter(Boolean));
  return { ids: protectedIds, digest: digest({
    protectedMembers: sourceMembers.filter((member) => protectedIds.has(member.id))
      .map((member) => Object.fromEntries(Object.entries(member).filter(([key]) => !managed.has(key)))),
    unrelatedSourcePrefs: sourcePrefs.filter((row) => !fieldIds.includes(row.field_id)),
    outsideTargetPrefs: targetPrefs.filter((row) => !currentIds.has(row.member_id)),
    protectedRelationships: protectedRelationshipRows(edges, protectedIds, managedRelationshipMemberIds, hierarchy.memberDefinition.id),
  }) };
}
export function protectedRelationshipRows(edges, protectedIds, managedMemberIds, managedDefinitionId) {
  return (edges || []).filter((row) => protectedIds.has(row.target_record_id)
    && (row.relationship_definition_id !== managedDefinitionId || !managedMemberIds.has(row.target_record_id)));
}
function report(source, state, mappings, hierarchy, plan) {
  const count = (action) => plan.items.filter((item) => item.action === action).length;
  console.log('\n--- Validated pinned source and destination ---');
  console.log(`  CSV SHA-256 / rows / columns:     ${source.fingerprint} / ${source.rows.length} / ${COLUMN_COUNT}`);
  console.log(`  Existing Members matched by email:${state.members.length}/${ROW_COUNT}`);
  console.log(`  Hierarchy org/dept/none:          ${source.counts.organization}/${source.counts.department}/${source.counts.none}`);
  console.log(`  Approved core/custom mappings:    ${CORE_MAPPINGS.length}/${mappings.length}`);
  for (const chain of hierarchy.organizationChains) console.log(`  Row ${chain.sourceRow}: Organisation ${chain.organizationId} -> Group ${chain.groupId}`);
  for (const chain of hierarchy.departmentChains) console.log(`  Row ${chain.sourceRow}: Department ${chain.departmentId} -> Organisation ${chain.organizationId} -> Group ${chain.groupId}`);
  console.log('\n--- Planned field-level changes ---');
  console.log(`  Members insert/update/unchanged:  ${count('insert')}/${count('update')}/${count('unchanged')}`);
  for (const item of plan.items) {
    const core = Object.entries(item.patch).map(([field, desired]) => `${field}: ${JSON.stringify(item.member?.[field] ?? null)} -> ${JSON.stringify(desired)}`);
    const prefs = item.preferences.filter((pref) => pref.action !== 'unchanged').map((pref) => `${pref.mapping.label}: ${JSON.stringify(pref.existing?.value ?? null)} -> ${JSON.stringify(pref.desired)}`);
    console.log(`  Row ${item.row.sourceRow} ${item.row.email}: ${item.action}; ${[...core, ...prefs, `relationship: ${item.edgeAction}`].join('; ')}`);
  }
  console.log(`  No relationship supplied (preserved, never guessed): ${noReferenceRows(source).map((row) => `${row.sourceRow}:${row.email}`).join(', ')}`);
  console.log('  Blank source cells: preserved; communications/workflows/finance/login: untouched');
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some((arg) => arg !== '--apply')) fail('Only --apply is supported; no --apply performs a dry run.');
  console.log(`\n=== BNMS honorary Member import (${apply ? 'APPLY' : 'DRY RUN — NO WRITES'}) ===`);
  const source = readSource();
  const db = destinationClient();
  const state = await loadState(db, source);
  const mappings = auditMappings(state.fields, source);
  const hierarchy = auditHierarchy(source, state);
  const plan = makePlan(source, state, mappings, hierarchy);
  report(source, state, mappings, hierarchy, plan);
  if (!apply) return console.log('\n=== DRY RUN complete: no database rows modified ===\n');
  const before = await preservationSnapshot(db, source, mappings, hierarchy);
  const insertedNoReferenceEmails = new Set(plan.items.filter((item) => !item.member
    && !item.row.values[19] && !item.row.values[20]).map((item) => item.row.email));
  const result = await applyPlan(db, plan, hierarchy);
  await verifyOrCompensate(result.journal, async () => {
    const verified = await loadState(db, source);
    const verifiedMappings = auditMappings(verified.fields, source);
    const verifiedHierarchy = auditHierarchy(source, verified);
    const replay = makePlan(source, verified, verifiedMappings, verifiedHierarchy);
    const pending = replay.items.filter((item) => item.action !== 'unchanged'
      || item.preferences.some((pref) => pref.action !== 'unchanged')
      || !['none', 'unchanged'].includes(item.edgeAction));
    if (verified.members.length !== ROW_COUNT || pending.length) fail(`Post-import replay verification failed: ${pending.length} rows still propose writes.`);
    if (replay.items.filter((item) => item.departmentId && item.edgeAction === 'unchanged').length !== ASSIGNMENT_COUNTS.department) fail('Post-import Department relationship count failed.');
    const invalidRelationshipRows = replay.items.filter((item) => {
      const active = item.activeDepartmentEdges || [];
      if (item.departmentId) return active.length !== 1 || active[0].source_record_id !== item.departmentId;
      if (item.row.values[19]) return active.length !== 0;
      return insertedNoReferenceEmails.has(item.row.email) && active.length !== 0;
    });
    if (invalidRelationshipRows.length) fail(`Post-import exact relationship verification failed for ${invalidRelationshipRows.length} row(s).`);
    const after = await preservationSnapshot(db, source, verifiedMappings, verifiedHierarchy, before.ids);
    if (before.digest !== after.digest) fail('Preservation verification failed: unrelated data changed.');
  });
  console.log(`\nApplied ${result.memberWrites} Member, ${result.preferenceWrites} preference, and ${result.edgeWrites} relationship writes.`);
  console.log(`Verified ${ROW_COUNT} Members and ${ASSIGNMENT_COUNTS.department} Department relationships. Replay: zero writes.\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`\nERROR: ${error.message}`); process.exit(1); });
}
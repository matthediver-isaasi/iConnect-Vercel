#!/usr/bin/env node
/**
 * Dry-run-first import of the pinned BNMS departmental-contact CSV.
 *
 * Usage:
 *   node scripts/import-bnms-departmental-contacts.mjs
 *   node scripts/import-bnms-departmental-contacts.mjs --apply
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import {
  TENANT_ID, applyPlan, clean, emailKey, parseBritishDate, transformed,
  verifyOrCompensate,
} from './import-bnms-direct-debit-members.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'attached_assets', 'Departmental_contacts_to_import_04.09.26_v1_1788530686371.csv');
export const EXPECTED_FILE_SHA256 = '8372c946ab45ce657e7370f04f779b10ec423ead1b53207c69a1059c6573dd6a';
export const ROW_COUNT = 174;
export const DEPARTMENT_COUNT = 167;
export const APPROVED_DEPARTMENT_REPLACEMENTS = Object.freeze({
  'ad731b3d-c4bb-4f21-a58d-9ef85800a3ff': '31eed8be-ad30-426b-9771-dde17af3495f',
  '197b6854-fdc8-4ea0-b78d-e61d346bd1fc': '78815a75-a597-42ea-94d8-dd0c6c3d281e',
  'e2633069-3409-4146-b28c-148263acb7b3': 'cf7e7f81-3fb3-42bd-9872-1065e426c6a1',
});
export const APPROVED_LEGACY_ID_REPLACEMENTS = Object.freeze({
  'adrian.list@stgeorges.nhs.uk': ['56536197', '56536196'],
  'ajaysree99@yahoo.com': ['56480693', '56536097'],
  'aline.demmery@uhbw.nhs.uk': ['56480657', '56535899'],
  'alison.lee@wales.nhs.uk': ['56480736', '56536035'],
  'amanda.morton@belfasttrust.hscni.net': ['56536166', '56536165'],
  'andrew.bussey@nhs.net': ['58232733', '56535993'],
  'anna.hallam1@nhs.net': ['56480712', '56536178'],
  'chloe.bowen1@nhs.net': ['56480685', '63353795'],
  'chris.ocallaghan@wales.nhs.uk': ['56480654', '56536250'],
  'christos.chatzigiannis@lanarkshire.scot.nhs.uk': ['79749261', '56536026'],
  'daniel.mccool@nhs.net': ['56480416', '56536122'],
  'david.jones9@wales.nhs.uk': ['56480585', '81395819'],
  'david.simpson3@nhs.net': ['56480499', '56536020'],
  'david.towey@royalberkshire.nhs.uk': ['56480511', '56536290'],
  'duncan.white@nhs.net': ['56480442', '56536101'],
  'elaine.noonan@rlbuht.nhs.uk': ['56480566', '56536136'],
  'elena.macias@nhs.net': ['56480603', '56536092'],
  'francis.grew@nhs.net': ['71459198', '56536187'],
  'g.keramida@rbht.nhs.uk': ['56480761', '56535975'],
  'garry.mcdermott@nhs.net': ['56605377', '56536212'],
  'heather.williams34@nhs.net': ['71536225', '56536222'],
  'heather.wright5@nhs.net': ['63543109', '56535905'],
  'james.scuffham@nhs.net': ['56480495', '56536156'],
  'janelle.reyes-goddard@nhs.net': ['56535913', '56535912'],
  'jim.mcgarvie@aapct.scot.nhs.uk': ['56480405', '56535870'],
  'john.dickson2@nhs.net': ['56480429', '56536240'],
  'john.thompson@mbht.nhs.uk': ['56605427', '56535955'],
  'julian.williams@uhs.nhs.uk': ['66953696', '56536185'],
  'julie.speakman2@nhs.net': ['56480733', '56536254'],
  'karen.whicker2@nhs.net': ['56536245', '56536244'],
  'katrina.cockburn@nhs.net': ['56480775', '56536041'],
  'khalid.hussain@uhb.nhs.uk': ['64015895', '56535882'],
  'lisa.rowley@uhcw.nhs.uk': ['56480641', '56536241'],
  'margaret.higgins@liverpoolft.nhs.uk': ['56480479', '56535861'],
  'marshallc3@cardiff.ac.uk': ['56480487', '56536264'],
  'martyn.farmer@nhs.net': ['56605382', '56536246'],
  'matthew.gray@nnuh.nhs.uk': ['56480838', '56536049'],
  'monica.martins@wales.nhs.uk': ['56480696', '56536179'],
  'mythili.sivananthan@bedfordhospital.nhs.uk': ['58393302', '56535878'],
  'nicholas.vennart@nhs.net': ['56536085', '56536182'],
  'nik.barnes@alderhey.nhs.uk': ['56480525', '56535862'],
  "peter.o'sullivan@ncic.nhs.uk": ['56535934', '56536269'],
  'rachel.rhodes2@nhs.net': ['73198680', '56536115'],
  'richard.poyner@nhs.net': ['59115939', '56536117'],
  'rose.hazell-evans@wsh.nhs.uk': ['56480798', '56536274'],
  'ruth.cornwell@ldh.nhs.uk': ['57329891', '56536014'],
  'sarah.allen@gstt.nhs.uk': ['56535972', '56536208'],
  'sarah.stace@wales.nhs.uk': ['56480484', '56536282'],
  'scott.smith2@ggc.scot.nhs.uk': ['56605433', '56535958'],
  'sfrancis2@nhs.net': ['56480614', '56536080'],
  'thescandoc@gmail.com': ['56480521', '56536171'],
  'tim.watts@nhs.net': ['75851470', '56536036'],
  'wailupwong@gmail.com': ['56480626', '56536028'],
});
export const COLUMN_COUNT = 9;
export const HEADERS = Object.freeze([
  'YM Web Site Member ID', 'Department UUID', 'First Name', 'Last Name', 'Email',
  'Member Since', 'Membership status', 'Member class', 'YM Membership type',
]);
export const CORE_MAPPINGS = Object.freeze([
  { column: 2, destination: 'first_name' },
  { column: 3, destination: 'last_name' },
  { column: 4, destination: 'email', transform: 'email' },
  { column: 5, destination: 'created_on', transform: 'date' },
]);
export const CUSTOM_MAPPINGS = Object.freeze([
  ['50d7b71c-29b0-4d4c-a817-f39edf35f2e0', 0, 'ym_web_site_member_id', 'YM Web Site Member ID', 'text'],
  ['388e1dfe-d917-4317-933a-0319542a7d92', 6, 'membership_status', 'Membership status', 'dropdown'],
  ['87f120ff-92e6-4d52-944b-9ba9d7b1fac0', 7, 'member_class', 'Member class', 'dropdown'],
  ['40bdb74f-e8e0-4ad1-9760-b1128256a752', 8, 'ym_membership_type', 'YM Membership type', 'dropdown', { 'Hospital Department': 'Hospital Departmental Contact' }],
].map(([id, column, name, label, type, valueMap]) => ({ id, column, name, label, type, valueMap })));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message) => { throw new Error(message); };
const check = (error, context) => { if (error) fail(`${context}: ${error.message}`); };
const sameValue = (actual, desired) => clean(actual) === clean(desired);
const mappedValue = (mapping, value) => mapping.valueMap?.[value] ?? value;
const effectiveDepartmentId = (id) => APPROVED_DEPARTMENT_REPLACEMENTS[id] || id;

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
    if (values.some((value) => !value)) fail(`CSV row ${sourceRow} must populate all nine columns.`);
    if (!UUID_RE.test(values[1])) fail(`CSV row ${sourceRow} has invalid Department UUID.`);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values[4])) fail(`CSV row ${sourceRow} has invalid Email "${values[4]}".`);
    parseBritishDate(values[5], `Member Since at row ${sourceRow}`);
    return { sourceRow, legacyId: values[0], departmentId: values[1], email: emailKey(values[4]), values };
  }).filter(Boolean);
  if (rows.length !== ROW_COUNT) fail(`CSV must contain exactly ${ROW_COUNT} populated rows; found ${rows.length}.`);
  for (const [key, label] of [['email', 'normalized Email'], ['legacyId', 'YM Web Site Member ID']]) {
    const seen = new Map();
    for (const row of rows) {
      if (seen.has(row[key])) fail(`Duplicate ${label} at rows ${seen.get(row[key])} and ${row.sourceRow}.`);
      seen.set(row[key], row.sourceRow);
    }
  }
  for (const [column, expected] of [[6, 'Active'], [7, 'Department contact'], [8, 'Hospital Department']]) {
    const actual = [...new Set(rows.map((row) => row.values[column]))];
    if (actual.length !== 1 || actual[0] !== expected) fail(`${HEADERS[column]} values drifted: ${actual.join(', ')}.`);
  }
  const departmentIds = new Set(rows.map((row) => row.departmentId));
  if (departmentIds.size !== DEPARTMENT_COUNT) fail(`CSV must reference exactly ${DEPARTMENT_COUNT} distinct Departments; found ${departmentIds.size}.`);
  return { rows, fingerprint, departmentIds };
}

export function auditLegacyIdReplacementContract(source, approvals = APPROVED_LEGACY_ID_REPLACEMENTS) {
  if (Object.keys(approvals).length !== 53) fail(`Expected exactly 53 approved legacy ID replacements; found ${Object.keys(approvals).length}.`);
  const rowsByEmail = new Map(source.rows.map((row) => [row.email, row]));
  for (const [email, pair] of Object.entries(approvals)) {
    const row = rowsByEmail.get(email);
    if (!row || !Array.isArray(pair) || pair.length !== 2 || !pair[0] || row.legacyId !== pair[1]) {
      fail(`Approved legacy ID replacement contract drifted for "${email}".`);
    }
  }
  return approvals;
}

export function readSource(file = FILE) {
  const source = parseSourceBytes(readFileSync(file));
  auditLegacyIdReplacementContract(source);
  return source;
}

export function auditMappings(fields, source) {
  return CUSTOM_MAPPINGS.map((contract) => {
    const candidates = fields.filter((field) => field.id === contract.id || field.name === contract.name || field.label === contract.label);
    if (candidates.length !== 1) fail(`Expected one unambiguous live field for "${contract.label}"; found ${candidates.length}.`);
    const field = candidates[0];
    if (field.id !== contract.id || field.tenant_id !== TENANT_ID || field.entity_scope !== 'member'
      || field.name !== contract.name || field.label !== contract.label
      || field.field_type !== contract.type || field.is_active !== true) fail(`Live field contract drifted for "${contract.label}".`);
    const requested = [...new Set(source.rows.map((row) => mappedValue(contract, row.values[contract.column])))];
    if (contract.type === 'dropdown') {
      const allowed = new Set((field.options || []).flatMap((option) => [clean(option?.value), clean(option?.label)]).filter(Boolean));
      const unsupported = requested.filter((value) => !allowed.has(value));
      if (unsupported.length) fail(`Unsupported "${contract.label}" value(s): ${unsupported.join(', ')}. Values are never canonicalized automatically.`);
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
  const departments = uniqueById(state.departments, 'Department');
  const organizations = uniqueById(state.organizations, 'Organisation');
  const definitions = state.relationshipDefinitions || [];
  const parentDefs = definitions.filter((item) => item.relationship_key === 'organisation' && item.tenant_id === TENANT_ID
    && item.source_kind === 'custom_object' && item.target_kind === 'organization'
    && item.target_custom_object_id == null && item.cardinality === 'many_to_one' && item.is_required === true && item.status === 'active');
  const memberDefs = definitions.filter((item) => item.relationship_key === 'members' && item.tenant_id === TENANT_ID
    && item.source_kind === 'custom_object' && item.target_kind === 'member'
    && item.target_custom_object_id == null && item.cardinality === 'many_to_many' && item.is_required === false && item.status === 'active');
  if (parentDefs.length !== 1 || memberDefs.length !== 1 || parentDefs[0].source_custom_object_id !== memberDefs[0].source_custom_object_id) {
    fail(`Department relationship model requires exactly one compatible "organisation" and "members" definition; found ${parentDefs.length}/${memberDefs.length}.`);
  }
  const departmentParents = new Map();
  const effectiveDepartmentIds = new Set([...source.departmentIds].map(effectiveDepartmentId));
  for (const id of effectiveDepartmentIds) {
    const department = departments.get(id);
    if (department?.tenant_id !== TENANT_ID || department.archived_at != null
      || department.custom_object_id !== memberDefs[0].source_custom_object_id) {
      fail(`Department ${id} is missing, archived, outside BNMS, or belongs to the wrong object.`);
    }
    const edges = (state.parentEdges || []).filter((edge) => edge.archived_at == null
      && edge.relationship_definition_id === parentDefs[0].id && edge.source_record_id === id);
    const organization = edges.length === 1 ? organizations.get(edges[0].target_record_id) : null;
    if (edges.length !== 1 || edges[0].tenant_id !== TENANT_ID || organization?.tenant_id !== TENANT_ID) {
      fail(`Department ${id} must have exactly one active BNMS Organisation parent; found ${edges.length}.`);
    }
    departmentParents.set(id, organization.id);
  }
  return {
    departmentParents, memberDefinition: memberDefs[0], parentDefinition: parentDefs[0],
    effectiveDepartmentIds,
    approvedDepartmentReplacements: new Map(Object.entries(APPROVED_DEPARTMENT_REPLACEMENTS)),
  };
}

export function makePlan(source, state, mappings, hierarchy) {
  const membersByEmail = new Map();
  for (const member of state.members || []) {
    const key = emailKey(member.email);
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
    const legacyMapping = mappings.find((mapping) => mapping.column === 0);
    const existingLegacy = member ? (preferenceGroups.get(`${member.id}|${legacyMapping.id}`) || []) : [];
    if (existingLegacy.length > 1) fail(`Duplicate preference values for "${row.email}", field "${legacyMapping.label}".`);
    if (existingLegacy[0] && !sameValue(existingLegacy[0].value, row.legacyId)) {
      const approved = (source.approvedLegacyIdReplacements || APPROVED_LEGACY_ID_REPLACEMENTS)[row.email];
      if (!approved || !sameValue(existingLegacy[0].value, approved[0]) || row.legacyId !== approved[1]) {
        fail(`Legacy member ID collision for "${row.email}": destination "${existingLegacy[0].value}", source "${row.legacyId}".`);
      }
    }
    const patch = {};
    for (const mapping of CORE_MAPPINGS) {
      const desired = transformed(row.values[mapping.column], mapping.transform, `${mapping.destination} at row ${row.sourceRow}`);
      const matches = mapping.transform === 'date'
        ? clean(member?.[mapping.destination]).slice(0, 10) === desired
        : member && sameValue(member[mapping.destination], desired);
      if (!matches) patch[mapping.destination] = desired;
    }
    const departmentId = effectiveDepartmentId(row.departmentId);
    const organizationId = hierarchy.departmentParents.get(departmentId);
    if (!member || member.organization_id !== organizationId) patch.organization_id = organizationId;
    const preferences = mappings.map((mapping) => {
      const desired = mappedValue(mapping, row.values[mapping.column]);
      const existing = member ? (preferenceGroups.get(`${member.id}|${mapping.id}`) || []) : [];
      if (existing.length > 1) fail(`Duplicate preference values for "${row.email}", field "${mapping.label}".`);
      return { mapping, desired, existing: existing[0] || null, action: !existing.length ? 'insert' : sameValue(existing[0].value, desired) ? 'unchanged' : 'update' };
    });
    const activeDepartmentEdges = member ? (state.memberEdges || []).filter((edge) => edge.target_record_id === member.id
      && edge.relationship_definition_id === hierarchy.memberDefinition.id && edge.archived_at == null) : [];
    if (activeDepartmentEdges.some((edge) => edge.tenant_id != null && edge.tenant_id !== TENANT_ID)) {
      fail(`Member "${row.email}" has an active Department edge outside BNMS.`);
    }
    const exactEdges = activeDepartmentEdges.filter((edge) => edge.source_record_id === departmentId);
    if (exactEdges.length > 1) fail(`Member "${row.email}" has duplicate active Department member edges for ${departmentId}.`);
    return {
      row, member, patch, action: member ? (Object.keys(patch).length ? 'update' : 'unchanged') : 'insert',
      preferences, departmentId, departmentIds: [departmentId],
      departmentAssignmentMode: 'ensure', edgeAction: exactEdges.length ? 'unchanged' : 'insert',
      conflictingEdges: [], exactEdges, activeDepartmentEdges,
    };
  }) };
}

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
  const ids = [...new Set([...source.departmentIds].flatMap((id) => [id, effectiveDepartmentId(id)]))];
  const [tenant, fields, organizations, departments, definitions, parentEdges, allMembers] = await Promise.all([
    db.from('tenant').select('id,name').eq('id', TENANT_ID).maybeSingle(),
    fetchAll(db, 'preference_field', 'id,tenant_id,name,label,field_type,entity_scope,is_active,options', (q) => q.eq('tenant_id', TENANT_ID).eq('entity_scope', 'member')),
    fetchAll(db, 'organization', 'id,tenant_id,name,organization_group_id', (q) => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'custom_object_record', 'id,tenant_id,custom_object_id,archived_at', (q) => q.in('id', ids)),
    fetchAll(db, 'custom_object_relationship_definition', 'id,tenant_id,relationship_key,source_kind,source_custom_object_id,target_kind,target_custom_object_id,cardinality,is_required,status', (q) => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'custom_object_relationship', 'id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at,archived_by', (q) => q.in('source_record_id', ids)),
    fetchAll(db, 'member', 'id,tenant_id,email,first_name,last_name,created_on,organization_id', (q) => q.eq('tenant_id', TENANT_ID)),
  ]);
  check(tenant.error, 'Could not resolve pinned BNMS tenant');
  if (tenant.data?.id !== TENANT_ID || !/\bbnms\b|british nuclear medicine society/i.test(tenant.data?.name || '')) fail('Pinned destination is not BNMS.');
  const emails = new Set(source.rows.map((row) => row.email));
  const members = allMembers.filter((member) => emails.has(emailKey(member.email)));
  const memberIds = members.map((member) => member.id);
  const [preferenceValues, memberEdges] = await Promise.all([
    memberIds.length ? fetchAll(db, 'member_preference_value', 'id,member_id,field_id,value', (q) => q.in('member_id', memberIds)) : [],
    memberIds.length ? fetchAll(db, 'custom_object_relationship', 'id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at,archived_by', (q) => q.in('target_record_id', memberIds)) : [],
  ]);
  return { tenant: tenant.data, fields, organizations, departments, relationshipDefinitions: definitions, parentEdges, members, preferenceValues, memberEdges };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const digest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

async function preservationSnapshot(db, source, mappings, hierarchy, protectedIds = null) {
  const allMembers = await fetchAll(db, 'member', '*', (q) => q.eq('tenant_id', TENANT_ID));
  const emails = new Set(source.rows.map((row) => row.email));
  const sourceMembers = allMembers.filter((member) => emails.has(emailKey(member.email)));
  const currentIds = new Set(sourceMembers.map((member) => member.id));
  const ids = protectedIds || currentIds;
  const fieldIds = mappings.map((mapping) => mapping.id);
  const [sourcePrefs, targetPrefs, edges] = await Promise.all([
    ids.size ? fetchAll(db, 'member_preference_value', '*', (q) => q.in('member_id', [...ids])) : [],
    fetchAll(db, 'member_preference_value', '*', (q) => q.in('field_id', fieldIds)),
    fetchAll(db, 'custom_object_relationship', '*', (q) => q.eq('relationship_definition_id', hierarchy.memberDefinition.id)),
  ]);
  const managed = new Set([...CORE_MAPPINGS.map((item) => item.destination), 'organization_id', 'updated_at']);
  return { ids, digest: digest({
    protectedMembers: sourceMembers.filter((member) => ids.has(member.id))
      .map((member) => Object.fromEntries(Object.entries(member).filter(([key]) => !managed.has(key)))),
    unrelatedSourcePrefs: sourcePrefs.filter((row) => !fieldIds.includes(row.field_id)),
    outsideTargetPrefs: targetPrefs.filter((row) => !currentIds.has(row.member_id)),
    outsideEdges: edges.filter((row) => !currentIds.has(row.target_record_id)),
    otherSourceEdges: edges.filter((row) => currentIds.has(row.target_record_id)
      && !source.rows.some((sourceRow) => effectiveDepartmentId(sourceRow.departmentId) === row.source_record_id
        && sourceMembers.some((member) => member.id === row.target_record_id && emailKey(member.email) === sourceRow.email))),
  }) };
}

function report(source, state, hierarchy, plan) {
  const count = (action) => plan.items.filter((item) => item.action === action).length;
  const preferenceWrites = plan.items.flatMap((item) => item.preferences).filter((item) => item.action !== 'unchanged').length;
  const edgeWrites = plan.items.filter((item) => item.edgeAction === 'insert').length;
  console.log('\n--- Validated pinned source and destination ---');
  console.log(`  CSV SHA-256 / rows / columns:      ${source.fingerprint} / ${source.rows.length} / ${COLUMN_COUNT}`);
  console.log(`  Unique Departments validated:      ${source.departmentIds.size}/${DEPARTMENT_COUNT}`);
  console.log(`  Approved Department replacements:  ${hierarchy.approvedDepartmentReplacements.size}`);
  console.log(`  Existing Members matched by email: ${state.members.length}/${ROW_COUNT}`);
  console.log(`  Members insert/update/unchanged:   ${count('insert')}/${count('update')}/${count('unchanged')}`);
  console.log(`  Preference / Department edge writes:${preferenceWrites}/${edgeWrites}`);
  for (const item of plan.items) {
    const core = Object.keys(item.patch);
    const prefs = item.preferences.filter((pref) => pref.action !== 'unchanged').map((pref) => pref.mapping.label);
    console.log(`  Row ${item.row.sourceRow} ${item.row.email}: ${item.action}; core=[${core.join(',')}]; prefs=[${prefs.join(',')}]; Department=${item.edgeAction}`);
  }
  console.log('  Existing unrelated fields and Department relationships are preserved.');
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some((arg) => arg !== '--apply')) fail('Only --apply is supported; no --apply performs a dry run.');
  console.log(`\n=== BNMS departmental-contact import (${apply ? 'APPLY' : 'DRY RUN — NO WRITES'}) ===`);
  const source = readSource();
  const db = destinationClient();
  const state = await loadState(db, source);
  const mappings = auditMappings(state.fields, source);
  const hierarchy = auditHierarchy(source, state);
  const plan = makePlan(source, state, mappings, hierarchy);
  report(source, state, hierarchy, plan);
  if (!apply) return console.log('\n=== DRY RUN complete: no database rows modified ===\n');
  const before = await preservationSnapshot(db, source, mappings, hierarchy);
  const result = await applyPlan(db, plan, hierarchy);
  await verifyOrCompensate(result.journal, async () => {
    const verified = await loadState(db, source);
    const verifiedMappings = auditMappings(verified.fields, source);
    const verifiedHierarchy = auditHierarchy(source, verified);
    const replay = makePlan(source, verified, verifiedMappings, verifiedHierarchy);
    const pending = replay.items.filter((item) => item.action !== 'unchanged'
      || item.preferences.some((pref) => pref.action !== 'unchanged') || item.edgeAction !== 'unchanged');
    if (verified.members.length !== ROW_COUNT || pending.length) fail(`Post-import replay verification failed: ${pending.length} rows still propose writes.`);
    if (replay.items.some((item) => item.exactEdges.length !== 1)) fail('Post-import Department relationship verification failed.');
    const after = await preservationSnapshot(db, source, verifiedMappings, verifiedHierarchy, before.ids);
    if (before.digest !== after.digest) fail('Preservation verification failed: unrelated data changed.');
  });
  console.log(`\nApplied ${result.memberWrites} Member, ${result.preferenceWrites} preference, and ${result.edgeWrites} relationship writes.`);
  console.log(`Verified ${ROW_COUNT} Members and ${ROW_COUNT} supplied Department relationships. Replay: zero writes.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`\nERROR: ${error.message}`); process.exit(1); });
}
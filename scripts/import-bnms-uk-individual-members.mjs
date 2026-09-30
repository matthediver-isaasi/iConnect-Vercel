#!/usr/bin/env node
/**
 * Guarded, dry-run-first import for the pinned BNMS UK individual workbook.
 * Usage: node scripts/import-bnms-uk-individual-members.mjs [--apply]
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import {
  TENANT_ID, applyPlan, clean, emailKey, memberAssignmentNullability,
  validateReturnedRows, verifyOrCompensate,
} from './import-bnms-direct-debit-members.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'attached_assets', '0_UK_individual_members_FINAL_IMPORT_CHECKED_06.09.26v2_1788687129640.xlsx');
export const EXPECTED_FILE_SHA256 = '44f378b11c67273352daf9809f4c7925f4b9c476f100afcad9c250025d04d4b3';
export const SHEET_NAME = 'Individual Members Import';
export const ROW_COUNT = 385;
export const COLUMN_COUNT = 29;
export const ASSIGNMENT_COUNTS = Object.freeze({ group: 146, organization: 105, department: 74, none: 60 });
export const HEADERS = Object.freeze([
  'YM Web Site Member ID', 'Member Since', 'Membership status', 'YM Date Membership Expires',
  'YM Membership type', 'Member class', 'First Name', 'Last Name', 'Title', 'Email',
  'Alternative email address', 'NMC address line 1', 'NMC address line 2', 'NMC address line 3',
  'NMC address city', 'NMC address post/zip code', 'NMC address country', 'Mobile',
  'Group UUID', 'Organisation UUID', 'Department UUID', 'BNMS Region', 'Occupation',
  'SRP/IRPA Affiliate', 'Qualifications', 'Trainee training scheme name',
  'Trainee training number', 'Trainee research fellow information', 'Category - Focus Area',
]);
export const CORE_MAPPINGS = Object.freeze([
  { column: 1, destination: 'created_on', transform: 'date' },
  { column: 6, destination: 'first_name' }, { column: 7, destination: 'last_name' },
  { column: 9, destination: 'email', transform: 'email' },
  { column: 17, destination: 'mobile', transform: 'phone' },
]);
export const CUSTOM_MAPPINGS = Object.freeze([
  ['50d7b71c-29b0-4d4c-a817-f39edf35f2e0', 0, 'ym_web_site_member_id', 'YM Web Site Member ID', 'text'],
  ['388e1dfe-d917-4317-933a-0319542a7d92', 2, 'membership_status', 'Membership status', 'dropdown'],
  ['2f04cda8-33f9-4df4-bcd5-e7150e4ca9ae', 3, 'ym_date_membership_expires', 'YM Date Membership Expires', 'text', 'validated-date'],
  ['40bdb74f-e8e0-4ad1-9760-b1128256a752', 4, 'ym_membership_type', 'YM Membership type', 'dropdown'],
  ['87f120ff-92e6-4d52-944b-9ba9d7b1fac0', 5, 'member_class', 'Member class', 'dropdown'],
  ['4f2e504c-1663-4dd8-a486-274159834320', 8, 'title', 'Title', 'dropdown'],
  ['b3d6ddbe-57c3-45a8-8f03-316f90b3dfbd', 10, 'alternative_email_address', 'Alternative email address', 'email'],
  ['706a4182-25f8-48a0-9642-3bb48b1cc075', 11, 'nmc_address_line_1', 'NMC address line 1', 'text'],
  ['56e237ec-d10b-446a-8356-87e738fcbeb1', 12, 'nmc_address_line_2', 'NMC address line 2', 'text'],
  ['96032fb1-34b1-45c1-a4ad-129fcc82eed1', 13, 'nmc_address_line_3', 'NMC address line 3', 'text'],
  ['c1c73f76-c9f6-4f13-bf21-e6ae4220c307', 14, 'nmc_address_city', 'NMC address city', 'text'],
  ['d8fb72fa-34bb-4adf-961a-1d6c7401ec52', 15, 'nmc_address_zip', 'NMC address post/zip code', 'text'],
  ['264fdf95-bde5-4d0b-bb38-1c69b7bf78d9', 16, 'nmc_address_country', 'NMC address country', 'country'],
  ['0e3e3b1f-5a3d-40b5-a4b5-f0761c115216', 21, 'member_region', 'Region', 'dropdown'],
  ['1c84695f-e8f8-4afd-b4be-e54f5f540a26', 22, 'occupation', 'Occupation', 'dropdown'],
  ['2dcf5b2b-670d-4058-a3a6-b48c084cca39', 23, 'srp/irpa_affiliate', 'SRP/IRPA Affiliate', 'boolean', 'boolean'],
  ['5a12aae9-d754-45ce-ac47-a97109a690e2', 24, 'qualifications', 'Qualifications', 'textarea'],
  ['b9937241-eb40-4510-9dd7-ec487f6d660d', 25, 'trainee_training_scheme_name', 'Trainee training scheme name', 'text'],
  ['1e2416d9-c338-4ed0-b982-97fd3db67653', 26, 'trainee_training_number', 'Trainee training number', 'text'],
  ['deac109c-7b27-467f-bacf-25b33e685cb6', 27, 'trainee_research_fellow_information', 'Trainee research fellow information', 'textarea'],
].map(([id, column, name, label, type, transform]) => ({ id, column, name, label, type, transform })));
export const FOCUS_AREA = Object.freeze({ column: 28, id: '9e6a7200-1194-4e75-98d1-25a29303e95e', name: 'Focus Area' });
export const ASSIGNMENT_OBJECT_ID = '1c1cdab9-5128-4e3d-b09e-b97088ae69ba';
export const ASSIGNMENT_MEMBER_DEFINITION_ID = '601544ca-9db9-498e-bd03-0af5e2c2e8a0';
export const ASSIGNMENT_ORGANIZATION_DEFINITION_ID = '184b26ff-c918-4162-98c4-1e16fde737ad';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE_RE = /^\+?[\d ()-]{5,30}$/;
const fail = (message) => { throw new Error(message); };
const check = (error, context) => { if (error) fail(`${context}: ${error.message}`); };

export function parseUsDate(value, context = 'date') {
  const match = clean(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!match) fail(`Invalid ${context} "${value}"; expected m/d/yy.`);
  const [, m, d, y] = match; const year = 2000 + Number(y);
  const date = new Date(Date.UTC(year, Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) fail(`Invalid ${context} "${value}".`);
  return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
function transform(value, kind, context) {
  if (kind === 'date') return parseUsDate(value, context);
  if (kind === 'validated-date') { parseUsDate(value, context); return clean(value); }
  if (kind === 'email') return emailKey(value);
  if (kind === 'boolean') {
    if (value === 'TRUE') return 'true';
    if (value === 'FALSE') return 'false';
    fail(`Invalid boolean at ${context}: "${value}".`);
  }
  return clean(value);
}

export function parseSourceBytes(bytes, { verifyFingerprint = true } = {}) {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (verifyFingerprint && fingerprint !== EXPECTED_FILE_SHA256) fail(`Workbook fingerprint mismatch; expected ${EXPECTED_FILE_SHA256}, found ${fingerprint}.`);
  const workbook = XLSX.read(bytes, { type: 'buffer', raw: false, cellDates: false });
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== SHEET_NAME) fail(`Workbook must contain exactly the "${SHEET_NAME}" sheet.`);
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[SHEET_NAME], { header: 1, raw: false, defval: '', blankrows: false });
  if (!grid.length || grid[0].length !== COLUMN_COUNT || grid[0].some((v, i) => clean(v) !== HEADERS[i])) fail(`Workbook must have the exact ${COLUMN_COUNT}-column positional header contract.`);
  const rows = grid.slice(1).map((input, index) => {
    const sourceRow = index + 2;
    if (input.length > COLUMN_COUNT) fail(`Row ${sourceRow} exceeds ${COLUMN_COUNT} columns.`);
    const values = Array.from({ length: COLUMN_COUNT }, (_, i) => clean(input[i]));
    if (!values.some(Boolean)) return null;
    if (!values[0] || !values[1] || !values[3] || !values[6] || !values[7] || !values[9]) fail(`Row ${sourceRow} has a blank required identity, name, or date.`);
    parseUsDate(values[1], `Member Since at row ${sourceRow}`); parseUsDate(values[3], `membership expiry at row ${sourceRow}`);
    if (!EMAIL_RE.test(values[9]) || (values[10] && !EMAIL_RE.test(values[10]))) fail(`Row ${sourceRow} has an invalid email.`);
    if (values[17] && !PHONE_RE.test(values[17])) fail(`Row ${sourceRow} has unsafe Mobile "${values[17]}".`);
    if ([18, 19, 20].filter((i) => values[i]).length > 1) fail(`Row ${sourceRow} has more than one hierarchy destination.`);
    for (const i of [18, 19, 20]) if (values[i] && !UUID_RE.test(values[i])) fail(`Row ${sourceRow} has invalid hierarchy UUID.`);
    if (!['TRUE', 'FALSE'].includes(values[23])) fail(`Row ${sourceRow} has invalid SRP/IRPA Affiliate.`);
    return { sourceRow, legacyId: values[0], email: emailKey(values[9]), values };
  }).filter(Boolean);
  if (rows.length !== ROW_COUNT) fail(`Workbook must contain exactly ${ROW_COUNT} populated rows; found ${rows.length}.`);
  for (const [key, label] of [['legacyId', 'legacy ID'], ['email', 'normalized email']]) {
    const seen = new Map();
    for (const row of rows) { if (seen.has(row[key])) fail(`Duplicate ${label} at rows ${seen.get(row[key])} and ${row.sourceRow}.`); seen.set(row[key], row.sourceRow); }
  }
  const counts = { group: rows.filter(r => r.values[18]).length, organization: rows.filter(r => r.values[19]).length, department: rows.filter(r => r.values[20]).length, none: rows.filter(r => !r.values[18] && !r.values[19] && !r.values[20]).length };
  if (Object.keys(counts).some(k => counts[k] !== ASSIGNMENT_COUNTS[k])) fail(`Hierarchy source counts drifted: ${JSON.stringify(counts)}.`);
  return { fingerprint, rows, counts };
}
export const readSource = (file = FILE) => parseSourceBytes(readFileSync(file));

function requested(source, column, split = false) {
  return [...new Set(source.rows.flatMap(row => (split ? row.values[column].split('|') : [row.values[column]]).map(clean).filter(Boolean)))];
}
export function auditMappings(fields, source) {
  return CUSTOM_MAPPINGS.map(contract => {
    const candidates = fields.filter(f => f.entity_scope === 'member' && (f.id === contract.id || f.name === contract.name || f.label === contract.label));
    if (candidates.length !== 1) fail(`Expected one unambiguous live field for "${contract.label}"; found ${candidates.length}.`);
    const field = candidates[0];
    if (field.id !== contract.id || field.tenant_id !== TENANT_ID || field.name !== contract.name || field.label !== contract.label || field.field_type !== contract.type || field.is_active !== true) fail(`Live field contract drifted for "${contract.label}".`);
    const values = requested(source, contract.column);
    if (contract.type === 'dropdown') {
      const allowed = new Set((field.options || []).flatMap(o => [clean(o?.value), clean(o?.label)]).filter(Boolean));
      const unsupported = values.filter(v => !allowed.has(v));
      if (unsupported.length) fail(`Unsupported "${contract.label}" value(s): ${unsupported.join(', ')}.`);
    } else if (field.options != null) fail(`Field "${contract.label}" unexpectedly has controlled options.`);
    return { ...contract, requested: values };
  });
}
export function auditFocusArea(categories, source) {
  const matches = categories.filter(c => c.id === FOCUS_AREA.id || c.name === FOCUS_AREA.name);
  if (matches.length !== 1 || matches[0].id !== FOCUS_AREA.id || matches[0].tenant_id !== TENANT_ID || matches[0].is_active !== true) fail('Live Focus Area category contract drifted.');
  const values = requested(source, FOCUS_AREA.column, true);
  const allowed = new Set((matches[0].subcategories || []).map(clean));
  const unsupported = values.filter(v => !allowed.has(v));
  if (unsupported.length) fail(`Unsupported Focus Area value(s): ${unsupported.join(', ')}.`);
  return { ...FOCUS_AREA, requested: values };
}

function byId(rows, label) {
  const result = new Map();
  for (const row of rows || []) { if (result.has(row.id)) fail(`Duplicate ${label} id "${row.id}".`); result.set(row.id, row); }
  return result;
}
export function auditHierarchy(source, state) {
  const groups = byId(state.groups, 'Group'); const organizations = byId(state.organizations, 'Organisation'); const departments = byId(state.departments, 'Department');
  const definitions = state.relationshipDefinitions || [];
  const parentDefs = definitions.filter(d => d.tenant_id === TENANT_ID && d.relationship_key === 'organisation' && d.source_kind === 'custom_object' && d.target_kind === 'organization' && d.cardinality === 'many_to_one' && d.status === 'active');
  const memberDefs = definitions.filter(d => d.tenant_id === TENANT_ID && d.relationship_key === 'members' && d.source_kind === 'custom_object' && d.target_kind === 'member' && d.cardinality === 'many_to_many' && d.status === 'active');
  if (parentDefs.length !== 1 || memberDefs.length !== 1 || parentDefs[0].source_custom_object_id !== memberDefs[0].source_custom_object_id) fail('Department relationship model drifted.');
  const assignmentMember = definitions.find(d => d.id === ASSIGNMENT_MEMBER_DEFINITION_ID);
  const assignmentOrganization = definitions.find(d => d.id === ASSIGNMENT_ORGANIZATION_DEFINITION_ID);
  const picker = memberDefs[0].configuration?.picker_scope;
  if (assignmentMember?.tenant_id !== TENANT_ID || assignmentMember.source_custom_object_id !== ASSIGNMENT_OBJECT_ID
    || assignmentMember.target_kind !== 'member' || assignmentMember.cardinality !== 'many_to_one' || assignmentMember.status !== 'active'
    || assignmentOrganization?.tenant_id !== TENANT_ID || assignmentOrganization.source_custom_object_id !== ASSIGNMENT_OBJECT_ID
    || assignmentOrganization.target_kind !== 'organization' || assignmentOrganization.cardinality !== 'many_to_one' || assignmentOrganization.status !== 'active'
    || picker?.version !== 2 || picker.match !== 'intersects'
    || picker.source_path?.length !== 1
    || picker.source_path[0]?.relationship_definition_id !== parentDefs[0].id
    || picker.source_path[0]?.from_side !== 'source'
    || picker.target_path?.length !== 2
    || picker.target_path?.[0]?.relationship_definition_id !== ASSIGNMENT_MEMBER_DEFINITION_ID
    || picker.target_path[0]?.from_side !== 'target'
    || picker.target_path?.[1]?.relationship_definition_id !== ASSIGNMENT_ORGANIZATION_DEFINITION_ID
    || picker.target_path[1]?.from_side !== 'source') {
    fail('Department picker-scope assignment model drifted.');
  }
  const departmentParents = new Map();
  for (const row of source.rows) {
    if (row.values[18] && groups.get(row.values[18])?.tenant_id !== TENANT_ID) fail(`Row ${row.sourceRow}: Group is missing or outside BNMS.`);
    if (row.values[19] && organizations.get(row.values[19])?.tenant_id !== TENANT_ID) fail(`Row ${row.sourceRow}: Organisation is missing or outside BNMS.`);
    if (row.values[20]) {
      const department = departments.get(row.values[20]);
      if (department?.tenant_id !== TENANT_ID || department.archived_at != null || department.custom_object_id !== memberDefs[0].source_custom_object_id) fail(`Row ${row.sourceRow}: Department is missing, archived, or outside BNMS.`);
      const edges = (state.parentEdges || []).filter(e => e.source_record_id === department.id && e.relationship_definition_id === parentDefs[0].id && e.archived_at == null);
      if (edges.length !== 1 || edges[0].tenant_id !== TENANT_ID || organizations.get(edges[0].target_record_id)?.tenant_id !== TENANT_ID) fail(`Row ${row.sourceRow}: Department must have exactly one BNMS Organisation parent.`);
      departmentParents.set(department.id, edges[0].target_record_id);
    }
  }
  return { memberDefinition: memberDefs[0], departmentParents, assignmentMember, assignmentOrganization };
}

async function fetchAll(db, table, columns, configure = q => q) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await configure(db.from(table).select(columns).order('id').range(from, from + 499));
    check(error, `Could not read ${table}`); rows.push(...(data || [])); if ((data || []).length < 500) return rows;
  }
}
export async function loadState(db, source) {
  const legacyFieldId = CUSTOM_MAPPINGS[0].id;
  const [tenant, fields, categories, groups, organizations, departments, relationshipDefinitions, parentEdges, allMembers, allLegacy, nullability] = await Promise.all([
    db.from('tenant').select('id,name').eq('id', TENANT_ID).maybeSingle(),
    fetchAll(db, 'preference_field', 'id,tenant_id,name,label,field_type,entity_scope,is_active,options', q => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'resource_category', 'id,tenant_id,name,subcategories,is_active', q => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'organization_group', 'id,tenant_id,name', q => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'organization', 'id,tenant_id,name,organization_group_id', q => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'custom_object_record', 'id,tenant_id,custom_object_id,archived_at', q => q.in('id', [...new Set(source.rows.map(r => r.values[20]).filter(Boolean))])),
    fetchAll(db, 'custom_object_relationship_definition', 'id,tenant_id,relationship_key,source_kind,source_custom_object_id,target_kind,target_custom_object_id,cardinality,is_required,status,configuration', q => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'custom_object_relationship', 'id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at,archived_by', q => q.in('source_record_id', [...new Set(source.rows.map(r => r.values[20]).filter(Boolean))])),
    fetchAll(db, 'member', 'id,tenant_id,email,first_name,last_name,created_on,mobile,organization_id,organization_group_id'),
    fetchAll(db, 'member_preference_value', 'id,member_id,field_id,value', q => q.eq('field_id', legacyFieldId).in('value', source.rows.map(r => r.legacyId))),
    memberAssignmentNullability(),
  ]);
  check(tenant.error, 'Could not resolve BNMS tenant');
  if (tenant.data?.id !== TENANT_ID || !/\bbnms\b|british nuclear medicine society/i.test(tenant.data?.name || '')) fail('Pinned destination is not BNMS.');
  const emails = new Set(source.rows.map(r => r.email)); const legacyMemberIds = new Set(allLegacy.map(v => v.member_id));
  const identityMembers = allMembers.filter(m => emails.has(emailKey(m.email)) || legacyMemberIds.has(m.id));
  const bnmsMembers = identityMembers.filter(m => m.tenant_id === TENANT_ID);
  const ids = bnmsMembers.map(m => m.id);
  const [preferenceValues, memberEdges, memberCategories] = ids.length ? await Promise.all([
    fetchAll(db, 'member_preference_value', 'id,member_id,field_id,value', q => q.in('member_id', ids)),
    fetchAll(db, 'custom_object_relationship', 'id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at,archived_by', q => q.in('target_record_id', ids)),
    fetchAll(db, 'member_resource_category', 'id,member_id,resource_category_id,subcategory_name', q => q.in('member_id', ids).eq('resource_category_id', FOCUS_AREA.id)),
  ]) : [[], [], []];
  const assignmentIds = memberEdges.filter(edge => edge.relationship_definition_id === ASSIGNMENT_MEMBER_DEFINITION_ID && edge.archived_at == null).map(edge => edge.source_record_id);
  const assignmentOrganizationEdges = assignmentIds.length
    ? await fetchAll(db, 'custom_object_relationship', 'id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at,archived_by',
      q => q.eq('relationship_definition_id', ASSIGNMENT_ORGANIZATION_DEFINITION_ID).in('source_record_id', assignmentIds))
    : [];
  const assignmentRecords = assignmentIds.length
    ? await fetchAll(db, 'custom_object_record', 'id,tenant_id,custom_object_id,archived_at', q => q.in('id', assignmentIds))
    : [];
  return { tenant: tenant.data, fields, categories, groups, organizations, departments, relationshipDefinitions, parentEdges, allLegacy, identityMembers, members: bnmsMembers, preferenceValues, memberEdges, assignmentOrganizationEdges, assignmentRecords, memberCategories, memberAssignmentNullability: nullability };
}

export function makePlan(source, state, mappings, hierarchy, focusArea) {
  const byEmail = new Map(); const byLegacy = new Map();
  for (const member of state.identityMembers || state.members || []) {
    const key = emailKey(member.email); if (!new Set(source.rows.map(r => r.email)).has(key)) continue;
    if (byEmail.has(key)) fail(`Ambiguous destination email "${key}".`);
    if (member.tenant_id !== TENANT_ID) fail(`Email "${key}" resolves outside BNMS.`); byEmail.set(key, member);
  }
  for (const value of state.allLegacy || []) {
    const member = (state.identityMembers || state.members || []).find(m => m.id === value.member_id);
    if (!member) fail(`Legacy ID "${value.value}" resolves to a missing Member.`);
    if (member.tenant_id !== TENANT_ID) fail(`Legacy ID "${value.value}" resolves outside BNMS.`);
    if (byLegacy.has(clean(value.value))) fail(`Ambiguous legacy ID "${value.value}".`); byLegacy.set(clean(value.value), member);
  }
  const prefs = new Map();
  for (const value of state.preferenceValues || []) {
    const key = `${value.member_id}|${value.field_id}`; if (prefs.has(key)) fail(`Duplicate preference value "${key}".`); prefs.set(key, value);
  }
  const cats = new Map();
  for (const value of state.memberCategories || []) {
    const key = `${value.member_id}|${clean(value.subcategory_name)}`; if (cats.has(key)) fail(`Duplicate Focus Area "${value.subcategory_name}".`); cats.set(key, value);
  }
  return { items: source.rows.map(row => {
    const emailMember = byEmail.get(row.email) || null; const legacyMember = byLegacy.get(row.legacyId) || null;
    if (emailMember && legacyMember && emailMember.id !== legacyMember.id) fail(`Row ${row.sourceRow}: email and legacy ID match different Members.`);
    const member = emailMember || legacyMember; const patch = {};
    for (const mapping of CORE_MAPPINGS) {
      if (!row.values[mapping.column]) continue;
      const desired = transform(row.values[mapping.column], mapping.transform, `${mapping.destination} at row ${row.sourceRow}`);
      const current = clean(member?.[mapping.destination]); const equal = mapping.transform === 'date' ? current.slice(0, 10) === desired : member && current === clean(desired);
      if (!equal) patch[mapping.destination] = desired;
    }
    const groupId = row.values[18] || null; let organizationId = row.values[19] || null;
    if (row.values[20]) organizationId = hierarchy.departmentParents.get(row.values[20]);
    if (groupId) { if (!member || member.organization_group_id !== groupId) patch.organization_group_id = groupId; if (member?.organization_id != null) patch.organization_id = null; }
    else if (organizationId) { if (!member || member.organization_id !== organizationId) patch.organization_id = organizationId; if (member?.organization_group_id != null) patch.organization_group_id = null; }
    const preferences = mappings.flatMap(mapping => {
      if (!row.values[mapping.column]) return [];
      const desired = String(transform(row.values[mapping.column], mapping.transform, `${mapping.label} at row ${row.sourceRow}`));
      const existing = member ? prefs.get(`${member.id}|${mapping.id}`) : null;
      return [{ mapping, desired, existing, action: !existing ? 'insert' : clean(existing.value) === clean(desired) ? 'unchanged' : 'update' }];
    });
    const focusAreas = row.values[focusArea.column].split('|').map(clean).filter(Boolean).map(name => {
      const existing = member ? cats.get(`${member.id}|${name}`) : null;
      return { name, existing, action: existing ? 'unchanged' : 'insert' };
    });
    const departmentId = row.values[20] || null;
    const activeDepartmentEdges = member ? (state.memberEdges || []).filter(e => e.target_record_id === member.id && e.relationship_definition_id === hierarchy.memberDefinition.id && e.archived_at == null) : [];
    if (activeDepartmentEdges.some(e => e.tenant_id !== TENANT_ID)) fail(`Member "${row.email}" has a Department edge outside BNMS.`);
    const exactEdges = departmentId ? activeDepartmentEdges.filter(e => e.source_record_id === departmentId) : [];
    if (exactEdges.length > 1) fail(`Member "${row.email}" has duplicate Department edges.`);
    const desiredOrganizationId = departmentId ? hierarchy.departmentParents.get(departmentId) : null;
    const liveAssignmentIds = new Set((state.assignmentRecords || []).filter(record =>
      record.tenant_id === TENANT_ID && record.custom_object_id === ASSIGNMENT_OBJECT_ID && record.archived_at == null).map(record => record.id));
    const memberAssignmentIds = member ? (state.memberEdges || []).filter(e =>
      e.target_record_id === member.id && e.relationship_definition_id === ASSIGNMENT_MEMBER_DEFINITION_ID
      && e.archived_at == null && e.tenant_id === TENANT_ID && liveAssignmentIds.has(e.source_record_id)).map(e => e.source_record_id) : [];
    const exactAssignments = (state.assignmentOrganizationEdges || []).filter(e =>
      memberAssignmentIds.includes(e.source_record_id) && e.relationship_definition_id === ASSIGNMENT_ORGANIZATION_DEFINITION_ID
      && e.target_record_id === desiredOrganizationId && e.archived_at == null && e.tenant_id === TENANT_ID);
    if (exactAssignments.length > 1) fail(`Member "${row.email}" has duplicate Organisation assignments for the Department parent.`);
    const assignmentAction = departmentId ? (exactAssignments.length === 1 ? 'unchanged' : 'insert') : 'none';
    return { row, member, patch, action: member ? (Object.keys(patch).length ? 'update' : 'unchanged') : 'insert', preferences, focusAreas, departmentId, departmentIds: departmentId ? [departmentId] : [], departmentAssignmentMode: departmentId ? 'ensure' : 'preserve', assignmentAction, exactAssignments, edgeAction: departmentId ? (exactEdges.length ? 'unchanged' : 'insert') : 'none', conflictingEdges: [], exactEdges, activeDepartmentEdges };
  }) };
}
export const pendingItems = plan => plan.items.filter(item => item.action !== 'unchanged' || item.preferences.some(p => p.action !== 'unchanged') || item.focusAreas.some(a => a.action !== 'unchanged') || item.assignmentAction === 'insert' || item.edgeAction === 'insert');
export function auditUnassigned(state, plan) {
  const inserts = plan.items.filter(i => !i.member && !i.row.values[18] && !i.row.values[19] && !i.row.values[20]);
  if (inserts.length && (!state.memberAssignmentNullability?.organization_id || !state.memberAssignmentNullability?.organization_group_id)) fail('New unassigned Members require nullable hierarchy columns.');
}

export async function applyIndividualPlan(db, plan, hierarchy, focusArea) {
  const withoutDepartmentEdges = { items: plan.items.map(item => ({ ...item, edgeAction: 'none' })) };
  const result = await applyPlan(db, withoutDepartmentEdges, hierarchy);
  try {
    const emails = new Set(plan.items.map(i => i.row.email));
    const members = await fetchAll(db, 'member', 'id,tenant_id,email', q => q.eq('tenant_id', TENANT_ID));
    const byEmail = new Map(members.filter(m => emails.has(emailKey(m.email))).map(m => [emailKey(m.email), m]));
    let categoryWrites = 0; let assignmentWrites = 0;
    for (const item of plan.items.filter(candidate => candidate.assignmentAction === 'insert')) {
      const member = byEmail.get(item.row.email); const organizationId = hierarchy.departmentParents.get(item.departmentId);
      const organization = (await db.from('organization').select('id,name').eq('tenant_id', TENANT_ID).eq('id', organizationId).single());
      check(organization.error, `Could not resolve Department parent Organisation for "${item.row.email}"`);
      const { data, error } = await db.rpc('create_custom_object_record_with_relationships', {
        p_tenant_id: TENANT_ID,
        p_custom_object_id: ASSIGNMENT_OBJECT_ID,
        p_data: { assignment_name: `${item.row.values[6]} ${item.row.values[7]} - ${organization.data.name}` },
        p_relationships: [
          { relationship_definition_id: ASSIGNMENT_MEMBER_DEFINITION_ID, routed_side: 'source', related_record_id: member.id },
          { relationship_definition_id: ASSIGNMENT_ORGANIZATION_DEFINITION_ID, routed_side: 'source', related_record_id: organizationId },
        ],
        p_created_by: 'system:bnms-uk-individual-import',
      }).single();
      check(error, `Could not create Organisation assignment for "${item.row.email}"`);
      const recordId = data?.record?.id; const relationshipIds = (data?.relationships || []).map(edge => edge.id);
      if (!recordId || relationshipIds.length !== 2) fail(`Organisation assignment for "${item.row.email}" returned an unexpected result.`);
      result.journal.push({ label: `delete Organisation assignment ${recordId}`, rollback: async () => {
        const { data: deletedEdges, error: edgeError } = await db.from('custom_object_relationship').delete().eq('tenant_id', TENANT_ID).in('id', relationshipIds).select('id');
        check(edgeError, 'Organisation assignment edge rollback failed');
        if ((deletedEdges || []).length !== 2) fail('Organisation assignment edge rollback was incomplete.');
        const { data: deletedRecord, error: recordError } = await db.from('custom_object_record').delete().eq('tenant_id', TENANT_ID).eq('id', recordId).select('id');
        check(recordError, 'Organisation assignment rollback failed');
        if ((deletedRecord || []).length !== 1) fail('Organisation assignment rollback was incomplete.');
      } });
      assignmentWrites += 1;
    }
    const edgePlan = { items: plan.items.map(item => ({
      ...item, member: byEmail.get(item.row.email), patch: {}, action: 'unchanged', preferences: [],
    })) };
    const edgeResult = await applyPlan(db, edgePlan, hierarchy);
    result.journal.push(...edgeResult.journal);
    result.edgeWrites += edgeResult.edgeWrites;
    for (const item of plan.items) {
      const member = byEmail.get(item.row.email); if (!member) fail(`Could not resolve imported Member "${item.row.email}".`);
      const writes = item.focusAreas.filter(a => a.action === 'insert').map(a => ({ member_id: member.id, resource_category_id: focusArea.id, subcategory_name: a.name }));
      if (!writes.length) continue;
      const { data, error } = await db.from('member_resource_category').insert(writes).select('id,member_id,resource_category_id,subcategory_name');
      check(error, `Could not write Focus Areas for "${item.row.email}"`); validateReturnedRows(data, writes, ['member_id', 'resource_category_id', 'subcategory_name']);
      const ids = data.map(r => r.id);
      result.journal.push({ label: `delete Focus Areas for ${member.id}`, rollback: async () => {
        const { data: deleted, error: rollbackError } = await db.from('member_resource_category').delete().in('id', ids).select('id');
        check(rollbackError, 'Focus Area rollback failed'); if ((deleted || []).length !== ids.length) fail('Focus Area rollback was incomplete.');
      } });
      categoryWrites += writes.length;
    }
    return { ...result, categoryWrites, assignmentWrites };
  } catch (error) { await verifyOrCompensate(result.journal, async () => { throw error; }); throw error; }
}

function report(source, plan) {
  const count = action => plan.items.filter(i => i.action === action).length;
  console.log(`Workbook SHA-256 / rows / columns: ${source.fingerprint} / ${source.rows.length} / ${COLUMN_COUNT}`);
  console.log(`Hierarchy group/org/department/none: ${source.counts.group}/${source.counts.organization}/${source.counts.department}/${source.counts.none}`);
  console.log(`Members create/update/unchanged/errors: ${count('insert')}/${count('update')}/${count('unchanged')}/0`);
  console.log(`Preference writes: ${plan.items.flatMap(i => i.preferences).filter(p => p.action !== 'unchanged').length}`);
  console.log(`Focus Area writes: ${plan.items.flatMap(i => i.focusAreas).filter(a => a.action !== 'unchanged').length}`);
  console.log(`Organisation assignment writes: ${plan.items.filter(i => i.assignmentAction === 'insert').length}`);
  console.log(`Department edge writes: ${plan.items.filter(i => i.edgeAction === 'insert').length}`);
}
async function main() {
  const args = process.argv.slice(2); const apply = args.includes('--apply');
  if (args.some(arg => arg !== '--apply')) fail('Only --apply is supported; no --apply performs a dry run.');
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required.');
  console.log(`\n=== BNMS UK individual import (${apply ? 'APPLY' : 'DRY RUN — NO WRITES'}) ===`);
  const source = readSource(); const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
  const state = await loadState(db, source); const mappings = auditMappings(state.fields, source); const focus = auditFocusArea(state.categories, source); const hierarchy = auditHierarchy(source, state);
  const plan = makePlan(source, state, mappings, hierarchy, focus); auditUnassigned(state, plan); report(source, plan);
  if (!apply) return console.log('DRY RUN complete: no writes.');
  const initial = { insert: plan.items.filter(i => i.action === 'insert').length, update: plan.items.filter(i => i.action === 'update').length, unchanged: plan.items.filter(i => i.action === 'unchanged').length };
  const result = await applyIndividualPlan(db, plan, hierarchy, focus);
  await verifyOrCompensate(result.journal, async () => {
    const verified = await loadState(db, source); const verifiedMappings = auditMappings(verified.fields, source); const verifiedFocus = auditFocusArea(verified.categories, source); const verifiedHierarchy = auditHierarchy(source, verified);
    const replay = makePlan(source, verified, verifiedMappings, verifiedHierarchy, verifiedFocus); auditUnassigned(verified, replay);
    const pending = pendingItems(replay);
    if (replay.items.some(i => !i.member) || pending.length) fail(`Post-import verification failed: ${pending.length} rows still propose writes.`);
    if (replay.items.filter(i => i.departmentId && i.assignmentAction === 'unchanged').length !== ASSIGNMENT_COUNTS.department) fail('Department Organisation assignment verification failed.');
    if (replay.items.filter(i => i.departmentId && i.edgeAction === 'unchanged').length !== ASSIGNMENT_COUNTS.department) fail('Department relationship verification failed.');
  });
  console.log(`Applied: ${initial.insert} created, ${initial.update} updated, ${initial.unchanged} unchanged; ${result.preferenceWrites} preferences, ${result.categoryWrites} Focus Areas, ${result.assignmentWrites} Organisation assignments, ${result.edgeWrites} Department edges. Replay: zero writes.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`ERROR: ${error.message}`); process.exit(1); });
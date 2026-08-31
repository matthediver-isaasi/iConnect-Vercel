#!/usr/bin/env node
/**
 * Dry-run-first import of the pinned BNMS direct-debit member CSV.
 *
 * Usage:
 *   node scripts/import-bnms-direct-debit-members.mjs
 *   node scripts/import-bnms-direct-debit-members.mjs --apply
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { parse } from 'csv-parse/sync';
import iconv from 'iconv-lite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'attached_assets', 'Direct_debit_payers_to_import_31.08.26_1788197290796.csv');
export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const EXPECTED_FILE_SHA256 = 'a0898e80a14d75659688afe596c09d8e072882db85197f5b52c11a97c49f8844';
export const ROW_COUNT = 356;
export const COLUMN_COUNT = 41;
export const ASSIGNMENT_COUNTS = Object.freeze({ directGroup: 101, organization: 83, department: 142, none: 30 });
export const HEADERS = Object.freeze([
  'YM Web Site Member ID', 'Member Since', 'YM Date Membership Expires', 'Email',
  'YM Membership type', 'Membership status', 'Direct Debit payment', 'Member class',
  'NMC address line 1', 'NMC address line 2', 'NMC address line 3', 'NMC address city',
  'NMC address post/zip code', 'NMC address country', 'First name', 'Last name', 'Title',
  'Alternative email address', 'Invoice address line 1', 'Invoice address line 2',
  'Invoice city', 'Invoice county/state', 'Invoice post/zip code', 'Invoice country',
  'Landline', 'Mobile', 'Group UUID', 'Organisation UUID', 'Department UUID', 'Occupation',
  'Qualifications', 'Notes', 'SRP/IRPA Affiliate', 'Qualifications',
  'Duration of NM experiece', 'Trainee training scheme name', 'Trainee training number',
  'Category - Focus Area', 'Region', '', '',
]);

export const CORE_MAPPINGS = Object.freeze([
  { column: 1, destination: 'created_on', transform: 'date' },
  { column: 3, destination: 'email', transform: 'email' },
  { column: 14, destination: 'first_name' },
  { column: 15, destination: 'last_name' },
  { column: 24, destination: 'landline' },
  { column: 25, destination: 'mobile' },
  // The approved positional contract intentionally maps AF ("Notes" in the export) here.
  { column: 31, destination: 'job_title' },
]);

export const CUSTOM_MAPPINGS = Object.freeze([
  ['50d7b71c-29b0-4d4c-a817-f39edf35f2e0', 0, 'ym_web_site_member_id', 'YM Web Site Member ID', 'text'],
  ['2f04cda8-33f9-4df4-bcd5-e7150e4ca9ae', 2, 'ym_date_membership_expires', 'YM Date Membership Expires', 'text', 'validated-date'],
  ['40bdb74f-e8e0-4ad1-9760-b1128256a752', 4, 'ym_membership_type', 'YM Membership type', 'dropdown'],
  ['388e1dfe-d917-4317-933a-0319542a7d92', 5, 'membership_status', 'Membership status', 'dropdown'],
  ['10e670d9-52e4-4811-8125-77f697cd54ea', 6, 'direct_debit_payment', 'Direct Debit payment', 'boolean', 'boolean'],
  ['87f120ff-92e6-4d52-944b-9ba9d7b1fac0', 7, 'member_class', 'Member class', 'dropdown'],
  ['706a4182-25f8-48a0-9642-3bb48b1cc075', 8, 'nmc_address_line_1', 'NMC address line 1', 'text'],
  ['56e237ec-d10b-446a-8356-87e738fcbeb1', 9, 'nmc_address_line_2', 'NMC address line 2', 'text'],
  ['96032fb1-34b1-45c1-a4ad-129fcc82eed1', 10, 'nmc_address_line_3', 'NMC address line 3', 'text'],
  ['c1c73f76-c9f6-4f13-bf21-e6ae4220c307', 11, 'nmc_address_city', 'NMC address city', 'text'],
  ['d8fb72fa-34bb-4adf-961a-1d6c7401ec52', 12, 'nmc_address_zip', 'NMC address post/zip code', 'text'],
  ['264fdf95-bde5-4d0b-bb38-1c69b7bf78d9', 13, 'nmc_address_country', 'NMC address country', 'country'],
  ['4f2e504c-1663-4dd8-a486-274159834320', 16, 'title', 'Title', 'dropdown'],
  ['b3d6ddbe-57c3-45a8-8f03-316f90b3dfbd', 17, 'alternative_email_address', 'Alternative email address', 'email'],
  ['764c4892-c12b-41bd-a9af-10a6a543f4fe', 18, 'invoice_address_line_1', 'Invoice address line 1', 'text'],
  ['61796f97-f8dc-42b1-8981-49853a1a60b5', 19, 'invoice_address_line_2', 'Invoice address line 2', 'text'],
  ['94c2d085-6cb8-41e7-a634-e6a6735b7e3e', 20, 'invoice_city', 'Invoice city', 'text'],
  ['fbc60ae4-c394-4f5e-b76a-0351499d0cf3', 21, 'invoice_county_state', 'Invoice county/state', 'text'],
  ['8983dc97-a0ed-4d81-9932-45900bca9b0b', 22, 'invoice_postcode', 'Invoice post/zip code', 'text'],
  ['6dcef4da-8c74-49fd-9d64-98bbb088af28', 23, 'invoice_country', 'Invoice country', 'country'],
  ['1c84695f-e8f8-4afd-b4be-e54f5f540a26', 29, 'occupation', 'Occupation', 'dropdown'],
  ['5a12aae9-d754-45ce-ac47-a97109a690e2', 30, 'qualifications', 'Qualifications', 'textarea'],
  ['2dcf5b2b-670d-4058-a3a6-b48c084cca39', 32, 'srp/irpa_affiliate', 'SRP/IRPA Affiliate', 'boolean', 'boolean'],
  ['6d8b47e1-c7b0-447b-9aef-3579dd8ecb74', 34, 'duration-of-nm-experiece', 'Duration of NM experiece', 'dropdown'],
  ['b9937241-eb40-4510-9dd7-ec487f6d660d', 35, 'trainee_training_scheme_name', 'Trainee training scheme name', 'text'],
  ['1e2416d9-c338-4ed0-b982-97fd3db67653', 36, 'trainee_training_number', 'Trainee training number', 'text'],
].map(([id, column, name, label, type, transform]) => ({ id, column, name, label, type, transform })));

export const IGNORED_COLUMNS = Object.freeze([
  { column: 33, reason: 'standardized duplicate Qualifications; no separate destination' },
  { column: 37, reason: 'no live field' }, { column: 38, reason: 'no live field' },
  { column: 39, reason: 'blank trailing column' }, { column: 40, reason: 'blank trailing column' },
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function fail(message) { throw new Error(message); }
function check(error, context) { if (error) fail(`${context}: ${error.message}`); }
export function clean(value) { return String(value ?? '').normalize('NFKC').trim(); }
export function emailKey(value) { return clean(value).toLocaleLowerCase('en-GB'); }

export function parseBritishDate(value, context = 'date') {
  const match = clean(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) fail(`Invalid ${context} "${value}"; expected dd/mm/yyyy.`);
  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText); const month = Number(monthText); const year = Number(yearText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail(`Invalid ${context} "${value}".`);
  }
  return `${yearText}-${monthText.padStart(2, '0')}-${dayText.padStart(2, '0')}`;
}

export function transformed(value, transform, context) {
  if (!value) return value;
  if (transform === 'date') return parseBritishDate(value, context);
  if (transform === 'validated-date') {
    parseBritishDate(value, context);
    return value;
  }
  if (transform === 'email') return emailKey(value);
  if (transform === 'boolean') {
    if (value === 'TRUE') return true;
    if (value === 'FALSE') return false;
    fail(`Invalid boolean at ${context}: "${value}".`);
  }
  return value;
}

export function parseSourceBytes(bytes, { verifyFingerprint = true } = {}) {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (verifyFingerprint && fingerprint !== EXPECTED_FILE_SHA256) {
    fail(`CSV fingerprint mismatch; expected ${EXPECTED_FILE_SHA256}, found ${fingerprint}.`);
  }
  const text = iconv.decode(bytes, 'windows-1252');
  const grid = parse(text, { bom: true, relax_column_count: false, skip_empty_lines: true });
  if (!grid.length || grid[0].length !== COLUMN_COUNT || grid[0].some((value, index) => clean(value) !== HEADERS[index])) {
    fail(`CSV must have the exact ${COLUMN_COUNT}-column positional header contract.`);
  }
  const rows = grid.slice(1).map((input, index) => {
    if (input.length !== COLUMN_COUNT) fail(`CSV row ${index + 2} must contain exactly ${COLUMN_COUNT} columns; found ${input.length}.`);
    const values = input.map(clean);
    if (!values.some(Boolean)) return null;
    const sourceRow = index + 2;
    if (!values[3] || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values[3])) fail(`CSV row ${sourceRow} has invalid Email "${values[3]}".`);
    if (values[1]) parseBritishDate(values[1], `Member Since at row ${sourceRow}`);
    if (values[2]) parseBritishDate(values[2], `membership expiry at row ${sourceRow}`);
    for (const column of [26, 27, 28]) {
      if (values[column] && !UUID_RE.test(values[column])) fail(`CSV row ${sourceRow} has invalid UUID in column ${column + 1}.`);
    }
    if (values[39] || values[40]) fail(`CSV row ${sourceRow} has data in ignored blank AN/AO columns.`);
    const assignmentCount = [26, 27, 28].filter((column) => values[column]).length;
    if (assignmentCount > 1) fail(`CSV row ${sourceRow} has more than one hierarchy destination.`);
    return { sourceRow, email: emailKey(values[3]), values };
  }).filter(Boolean);
  if (rows.length !== ROW_COUNT) fail(`CSV must contain exactly ${ROW_COUNT} populated rows; found ${rows.length}.`);
  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row.email)) fail(`Duplicate normalized Email at rows ${seen.get(row.email)} and ${row.sourceRow}.`);
    seen.set(row.email, row.sourceRow);
  }
  const counts = {
    directGroup: rows.filter((row) => row.values[26]).length,
    organization: rows.filter((row) => row.values[27]).length,
    department: rows.filter((row) => row.values[28]).length,
    none: rows.filter((row) => !row.values[26] && !row.values[27] && !row.values[28]).length,
  };
  if (Object.keys(counts).some((key) => counts[key] !== ASSIGNMENT_COUNTS[key])) {
    fail(`Hierarchy source counts drifted: ${JSON.stringify(counts)}.`);
  }
  return { rows, fingerprint, counts };
}

export function readSource(file = FILE) {
  return parseSourceBytes(readFileSync(file));
}

export function sourceFileFromArgs(args = process.argv.slice(2)) {
  let file = process.env.BNMS_DIRECT_DEBIT_CSV || FILE;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--file') continue;
    if (!args[index + 1] || args[index + 1].startsWith('--')) fail('--file requires a protected CSV path.');
    file = path.resolve(args[index + 1]);
    index += 1;
  }
  return file;
}

export function auditMappings(fields, source) {
  return CUSTOM_MAPPINGS.map((contract) => {
    const candidates = fields.filter((field) => field.id === contract.id || field.name === contract.name || field.label === contract.label);
    if (candidates.length !== 1) fail(`Expected one unambiguous live field for column ${contract.column + 1} "${contract.label}"; found ${candidates.length}.`);
    const field = candidates[0];
    if (field.id !== contract.id || field.tenant_id !== TENANT_ID || field.entity_scope !== 'member'
      || field.name !== contract.name || field.label !== contract.label || field.field_type !== contract.type || field.is_active !== true) {
      fail(`Live field contract drifted for "${contract.label}".`);
    }
    const requested = [...new Set(source.rows.map((row) => row.values[contract.column]).filter(Boolean))];
    if (contract.type === 'dropdown') {
      const allowed = new Set((field.options || []).flatMap((option) => [clean(option?.value), clean(option?.label)]).filter(Boolean));
      const unsupported = requested.filter((value) => !allowed.has(value));
      if (unsupported.length) {
        fail(`Unsupported "${contract.label}" value(s): ${unsupported.join(', ')}. Values are never canonicalized automatically.`);
      }
    } else if (field.options != null) fail(`Field "${contract.label}" unexpectedly has controlled options.`);
    return { ...contract, requested };
  });
}

function uniqueById(rows, label) {
  const map = new Map();
  for (const row of rows) {
    if (map.has(row.id)) fail(`Duplicate destination ${label} id ${row.id}.`);
    map.set(row.id, row);
  }
  return map;
}

export function auditHierarchy(source, state) {
  const groups = uniqueById(state.groups || [], 'Organisation Group');
  const organizations = uniqueById(state.organizations || [], 'Organisation');
  const departments = uniqueById(state.departments || [], 'Department');
  const groupIds = new Set(source.rows.map((row) => row.values[26]).filter(Boolean));
  const organizationIds = new Set(source.rows.map((row) => row.values[27]).filter(Boolean));
  const departmentIds = new Set(source.rows.map((row) => row.values[28]).filter(Boolean));
  for (const row of source.rows) {
    if (row.values[26] && groups.get(row.values[26])?.tenant_id !== TENANT_ID) fail(`Row ${row.sourceRow}: direct Organisation Group ${row.values[26]} is missing or outside BNMS.`);
    if (row.values[27] && organizations.get(row.values[27])?.tenant_id !== TENANT_ID) fail(`Row ${row.sourceRow}: Organisation ${row.values[27]} is missing or outside BNMS.`);
    if (row.values[28] && (departments.get(row.values[28])?.tenant_id !== TENANT_ID || departments.get(row.values[28])?.archived_at != null)) fail(`Row ${row.sourceRow}: Department ${row.values[28]} is missing, archived, or outside BNMS.`);
  }
  const definitions = state.relationshipDefinitions || [];
  const organisationDefinitions = definitions.filter((item) => item.relationship_key === 'organisation'
    && item.tenant_id === TENANT_ID
    && item.source_kind === 'custom_object' && item.target_kind === 'organization'
    && item.target_custom_object_id === null && item.cardinality === 'many_to_one'
    && item.is_required === true && item.status === 'active');
  const memberDefinitions = definitions.filter((item) => item.relationship_key === 'members'
    && item.tenant_id === TENANT_ID
    && item.source_kind === 'custom_object' && item.target_kind === 'member'
    && item.target_custom_object_id === null && item.cardinality === 'one_to_many'
    && item.is_required === false && item.status === 'active');
  if (organisationDefinitions.length !== 1 || memberDefinitions.length !== 1) {
    fail(`Department relationship model requires exactly one "organisation" and one "members" definition; found ${organisationDefinitions.length}/${memberDefinitions.length}.`);
  }
  if (organisationDefinitions[0].source_custom_object_id !== memberDefinitions[0].source_custom_object_id) {
    fail('Department organisation and members definitions belong to different custom objects.');
  }
  for (const department of departments.values()) {
    if (departmentIds.has(department.id) && department.custom_object_id !== memberDefinitions[0].source_custom_object_id) {
      fail(`Department ${department.id} belongs to the wrong custom object.`);
    }
  }
  const activeParents = (state.parentEdges || []).filter((edge) => edge.archived_at == null);
  const departmentParents = new Map();
  const organisationChains = [];
  const departmentChains = [];
  for (const row of source.rows.filter((item) => item.values[28])) {
    const id = row.values[28];
    const edges = activeParents.filter((edge) => edge.relationship_definition_id === organisationDefinitions[0].id && edge.source_record_id === id);
    if (edges.length !== 1 || edges[0].tenant_id !== TENANT_ID
      || organizations.get(edges[0].target_record_id)?.tenant_id !== TENANT_ID) {
      fail(`Row ${row.sourceRow}: Department ${id} must have exactly one active BNMS Organisation parent; found ${edges.length}.`);
    }
    const parent = organizations.get(edges[0].target_record_id);
    if (!parent.organization_group_id || groups.get(parent.organization_group_id)?.tenant_id !== TENANT_ID) {
      fail(`Row ${row.sourceRow}: Department ${id} -> Organisation ${parent.id} has no valid BNMS Organisation Group.`);
    }
    departmentParents.set(id, parent.id);
    departmentChains.push({ sourceRow: row.sourceRow, departmentId: id, organizationId: parent.id, groupId: parent.organization_group_id });
  }
  for (const row of source.rows.filter((item) => item.values[27])) {
    const organisation = organizations.get(row.values[27]);
    if (!organisation.organization_group_id || groups.get(organisation.organization_group_id)?.tenant_id !== TENANT_ID) {
      // Explicit import decision: Organisation-only rows remain assigned to their
      // Organisation when it is legitimately ungrouped. Department chains remain strict.
      organisationChains.push({ sourceRow: row.sourceRow, organizationId: organisation.id, groupId: null, approvedParentless: true });
      continue;
    }
    organisationChains.push({ sourceRow: row.sourceRow, organizationId: organisation.id, groupId: organisation.organization_group_id });
  }
  return {
    groupIds, organizationIds, departmentIds, departmentParents, organisationChains, departmentChains,
    organisationDefinition: organisationDefinitions[0], memberDefinition: memberDefinitions[0],
  };
}

function sameValue(actual, desired) {
  if (typeof desired === 'boolean') return actual === desired;
  return clean(actual) === clean(desired);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }

export function makePlan(source, state, mappings, hierarchy) {
  if (source.rows.some((row) => row.values[26]) && state.memberSupportsOrganizationGroup === false) {
    fail('Destination Member schema is missing required member.organization_group_id; direct Organisation Group assignments cannot be planned.');
  }
  const membersByEmail = new Map();
  const sourceEmails = new Set(source.rows.map((row) => row.email));
  for (const member of state.members || []) {
    const key = emailKey(member.email);
    if (!sourceEmails.has(key)) continue; // Unrelated BNMS Members are deliberately out of scope.
    if (membersByEmail.has(key)) fail(`Ambiguous destination Member email "${key}".`);
    if (member.tenant_id !== TENANT_ID) fail(`Email "${key}" resolved outside BNMS.`);
    membersByEmail.set(key, member);
  }
  const preferenceGroups = new Map();
  for (const value of state.preferenceValues || []) {
    const key = `${value.member_id}|${value.field_id}`;
    preferenceGroups.set(key, [...(preferenceGroups.get(key) || []), value]);
  }
  const memberEdges = state.memberEdges || [];
  const items = source.rows.map((row) => {
    const member = membersByEmail.get(row.email) || null;
    if (member && row.values[26] && !Object.hasOwn(member, 'organization_group_id')) {
      fail('Destination Member schema is missing required member.organization_group_id; direct Organisation Group assignments cannot be planned.');
    }
    const patch = {};
    for (const mapping of CORE_MAPPINGS) {
      const raw = row.values[mapping.column];
      if (!raw) continue; // A blank source value never clears a destination value.
      const desired = transformed(raw, mapping.transform, `column ${mapping.column + 1}, row ${row.sourceRow}`);
      const matches = mapping.transform === 'date'
        ? clean(member?.[mapping.destination]).slice(0, 10) === desired
        : member && sameValue(member[mapping.destination], desired);
      if (!matches) patch[mapping.destination] = desired;
    }
    const groupId = row.values[26] || null;
    let organizationId = null;
    if (row.values[27]) organizationId = row.values[27];
    if (row.values[28]) organizationId = hierarchy.departmentParents.get(row.values[28]);
    if (groupId) {
      if (!member || member.organization_group_id !== groupId) patch.organization_group_id = groupId;
      if (member?.organization_id != null) patch.organization_id = null;
    } else if (organizationId) {
      if (!member || member.organization_id !== organizationId) patch.organization_id = organizationId;
      if (member?.organization_group_id != null) patch.organization_group_id = null;
    }
    const preferences = mappings.flatMap((mapping) => {
      const raw = row.values[mapping.column];
      if (!raw) return []; // Never clear a preference from a blank.
      // member_preference_value.value is text, including boolean fields.
      const desired = String(transformed(raw, mapping.transform, `column ${mapping.column + 1}, row ${row.sourceRow}`));
      const existing = member ? (preferenceGroups.get(`${member.id}|${mapping.id}`) || []) : [];
      if (existing.length > 1) fail(`Duplicate preference values for "${row.email}", field "${mapping.label}".`);
      return [{ mapping, desired, existing: existing[0] || null, action: !member || !existing.length ? 'insert' : sameValue(existing[0].value, desired) ? 'unchanged' : 'update' }];
    });
    const departmentId = row.values[28] || null;
    const relatedEdges = member ? memberEdges.filter((edge) => edge.target_record_id === member.id) : [];
    const activeDepartmentEdges = relatedEdges.filter((edge) => edge.relationship_definition_id === hierarchy.memberDefinition.id
      && edge.archived_at == null);
    const exactEdges = departmentId ? relatedEdges.filter((edge) => edge.relationship_definition_id === hierarchy.memberDefinition.id
      && edge.source_record_id === departmentId && edge.archived_at == null) : [];
    if (exactEdges.length > 1) fail(`Member "${row.email}" has duplicate active Department member edges.`);
    const hasHierarchyReference = Boolean(groupId || organizationId || departmentId);
    const conflictingEdges = hasHierarchyReference ? relatedEdges.filter((edge) => edge.relationship_definition_id === hierarchy.memberDefinition.id
      && edge.archived_at == null && (!departmentId || edge.source_record_id !== departmentId)) : [];
    let edgeAction = 'none';
    if (departmentId) {
      if (exactEdges.length === 1) edgeAction = conflictingEdges.length ? 'archive' : 'unchanged';
      else edgeAction = conflictingEdges.length ? 'replace' : 'insert';
    } else if (hasHierarchyReference && conflictingEdges.length) {
      edgeAction = 'archive';
    }
    return {
      row, member, patch, action: member ? (Object.keys(patch).length ? 'update' : 'unchanged') : 'insert',
      preferences, departmentId, edgeAction, conflictingEdges, exactEdges, activeDepartmentEdges,
    };
  });
  return { items };
}

export function noReferenceRows(source) {
  return source.rows.filter((row) => !row.values[26] && !row.values[27] && !row.values[28])
    .map((row) => ({ sourceRow: row.sourceRow, email: row.email }));
}

export function auditNoReferenceEligibility(source, state, plan) {
  const newNoReference = plan.items.filter((item) => !item.member && !item.row.values[26] && !item.row.values[27] && !item.row.values[28]);
  if (!newNoReference.length) return;
  const nullable = state.memberAssignmentNullability;
  if (!nullable?.organization_id || !nullable?.organization_group_id) {
    fail(`Rows ${newNoReference.map((item) => item.row.sourceRow).join(', ')} have no hierarchy reference and cannot be inserted until member.organization_id and member.organization_group_id are confirmed nullable.`);
  }
}

export function validateReturnedRows(data, expected, keys, context = 'write') {
  if ((data || []).length !== expected.length) fail(`${context} returned ${(data || []).length}/${expected.length} rows.`);
  const wanted = new Map(expected.map((row) => [keys.map((key) => row[key]).join('|'), row]));
  for (const row of data || []) {
    const expectedRow = wanted.get(keys.map((key) => row[key]).join('|'));
    if (!expectedRow || Object.entries(expectedRow).some(([key, value]) => value !== undefined && !sameValue(row[key], value))) {
      fail(`${context} returned unexpected rows.`);
    }
  }
}

function destinationClient() {
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required; source and bare Supabase credentials are forbidden.');
  }
  return createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
}

async function fetchAll(db, table, columns, configure = (query) => query) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    let query = db.from(table).select(columns).order('id').range(from, from + 499);
    query = configure(query);
    const { data, error } = await query;
    check(error, `Could not read ${table}`);
    rows.push(...(data || []));
    if ((data || []).length < 500) return rows;
  }
}

async function memberAssignmentNullability() {
  if (!process.env.DEST_DATABASE_URL) {
    const response = await fetch(`${process.env.DEST_SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: process.env.DEST_SUPABASE_KEY,
        Authorization: `Bearer ${process.env.DEST_SUPABASE_KEY}`,
        Accept: 'application/openapi+json',
      },
    });
    if (!response.ok) return null;
    const document = await response.json();
    const member = document.definitions?.member || document.components?.schemas?.member;
    if (!member?.properties?.organization_id || !member?.properties?.organization_group_id) return null;
    const required = new Set(member.required || []);
    return {
      organization_id: !required.has('organization_id'),
      organization_group_id: !required.has('organization_group_id'),
    };
  }
  const client = new pg.Client({ connectionString: process.env.DEST_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const result = await client.query(
      `select column_name, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'member'
         and column_name in ('organization_id', 'organization_group_id')`,
    );
    const values = Object.fromEntries(result.rows.map((row) => [row.column_name, row.is_nullable === 'YES']));
    return { organization_id: values.organization_id === true, organization_group_id: values.organization_group_id === true };
  } finally {
    await client.end();
  }
}

async function loadSourceMembers(db) {
  const baseColumns = 'id,tenant_id,email,first_name,last_name,created_on,landline,mobile,job_title,organization_id';
  try {
    return {
      rows: await fetchAll(db, 'member', `${baseColumns},organization_group_id`, (q) => q.eq('tenant_id', TENANT_ID)),
      supportsOrganizationGroup: true,
    };
  } catch (error) {
    if (!/organization_group_id.*does not exist/i.test(error.message)) throw error;
    return {
      rows: await fetchAll(db, 'member', baseColumns, (q) => q.eq('tenant_id', TENANT_ID)),
      supportsOrganizationGroup: false,
    };
  }
}

export async function loadState(db, source) {
  const emails = source.rows.map((row) => row.email);
  const groupIds = [...new Set(source.rows.map((row) => row.values[26]).filter(Boolean))];
  const organizationIds = [...new Set(source.rows.flatMap((row) => [row.values[27]]).filter(Boolean))];
  const departmentIds = [...new Set(source.rows.map((row) => row.values[28]).filter(Boolean))];
  const [tenantResult, fields, groups, organizations, departments, definitions, parentEdges, memberState] = await Promise.all([
    db.from('tenant').select('id,name').eq('id', TENANT_ID).maybeSingle(),
    fetchAll(db, 'preference_field', 'id,tenant_id,name,label,field_type,entity_scope,is_active,options', (q) => q.eq('tenant_id', TENANT_ID).eq('entity_scope', 'member')),
    // Parent Organisations can point at groups not directly present in AA, so load all BNMS groups.
    fetchAll(db, 'organization_group', 'id,tenant_id,name', (q) => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'organization', 'id,tenant_id,name,organization_group_id', (q) => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'custom_object_record', 'id,tenant_id,custom_object_id,archived_at', (q) => q.in('id', departmentIds)),
    fetchAll(db, 'custom_object_relationship_definition', 'id,tenant_id,relationship_key,source_kind,source_custom_object_id,target_kind,target_custom_object_id,cardinality,is_required,status', (q) => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'custom_object_relationship', 'id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at,archived_by', (q) => q.in('source_record_id', departmentIds)),
    loadSourceMembers(db),
  ]);
  check(tenantResult.error, 'Could not resolve pinned BNMS tenant');
  if (tenantResult.data?.id !== TENANT_ID || !/\bbnms\b|british nuclear medicine society/i.test(tenantResult.data?.name || '')) fail('Pinned destination is not BNMS.');
  const allMembers = memberState.rows;
  const sourceEmails = new Set(source.rows.map((row) => row.email));
  const members = allMembers.filter((member) => sourceEmails.has(emailKey(member.email)));
  const memberIds = members.map((member) => member.id);
  const [preferenceValues, memberEdges] = await Promise.all([
    memberIds.length ? fetchAll(db, 'member_preference_value', 'id,member_id,field_id,value', (q) => q.in('member_id', memberIds)) : [],
    memberIds.length ? fetchAll(db, 'custom_object_relationship', 'id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at,archived_by', (q) => q.in('target_record_id', memberIds)) : [],
  ]);
  return {
    tenant: tenantResult.data, fields, groups, organizations, departments, relationshipDefinitions: definitions,
    parentEdges, members, allMembers, preferenceValues, memberEdges,
    memberSupportsOrganizationGroup: memberState.supportsOrganizationGroup,
    memberAssignmentNullability: memberState.supportsOrganizationGroup
      ? await memberAssignmentNullability()
      : { organization_id: true, organization_group_id: false },
  };
}

// This deliberately captures only records this importer must not mutate: all non-target
// fields on source Members, their non-target preferences, and target preferences/member
// relationship records belonging to Members outside the source email set.
export async function preservationSnapshot(db, source, mappings, hierarchy, preserveMemberIds = null) {
  const allMembers = await fetchAll(db, 'member', '*', (q) => q.eq('tenant_id', TENANT_ID));
  const sourceEmails = new Set(source.rows.map((row) => row.email));
  const sourceMembers = allMembers.filter((member) => sourceEmails.has(emailKey(member.email)));
  const currentSourceIds = new Set(sourceMembers.map((member) => member.id));
  const sourceIds = preserveMemberIds || currentSourceIds;
  const fieldIds = mappings.map((mapping) => mapping.id);
  const [sourcePreferences, targetPreferences, allMemberEdges] = await Promise.all([
    sourceIds.size ? fetchAll(db, 'member_preference_value', '*', (q) => q.in('member_id', [...sourceIds])) : [],
    fetchAll(db, 'member_preference_value', '*', (q) => q.in('field_id', fieldIds)),
    fetchAll(db, 'custom_object_relationship', '*', (q) => q.eq('relationship_definition_id', hierarchy.memberDefinition.id)),
  ]);
  const managedMemberKeys = new Set([...CORE_MAPPINGS.map((mapping) => mapping.destination), 'organization_id', 'organization_group_id', 'updated_at']);
  const protectedMembers = sourceMembers.filter((member) => sourceIds.has(member.id)).map((member) => Object.fromEntries(Object.entries(member)
    .filter(([key]) => !managedMemberKeys.has(key))));
  return {
    digest: digest({
    protectedMembers,
    unrelatedSourcePreferences: sourcePreferences.filter((row) => !fieldIds.includes(row.field_id)),
    outOfSourceTargetPreferences: targetPreferences.filter((row) => !currentSourceIds.has(row.member_id)),
    outOfSourceMemberEdges: allMemberEdges.filter((row) => !currentSourceIds.has(row.target_record_id)),
    }),
    memberIds: sourceIds,
  };
}

export async function runCompensated(steps) {
  const completed = [];
  try {
    for (const step of steps) {
      await step.apply();
      completed.push(step);
    }
  } catch (error) {
    const failures = [];
    for (const step of completed.reverse()) {
      try { await step.rollback(); } catch (rollbackError) { failures.push(rollbackError.message); }
    }
    if (failures.length) fail(`Apply failed (${error.message}) and compensation was incomplete: ${failures.join('; ')}`);
    throw error;
  }
}

export async function compensateJournal(journal, originalError) {
  const failures = [];
  for (const entry of [...journal].reverse()) {
    try { await entry.rollback(); } catch (error) { failures.push(`${entry.label}: ${error.message}`); }
  }
  if (failures.length) fail(`Apply failed (${originalError.message}) and compensation was incomplete: ${failures.join('; ')}`);
}

export async function verifyOrCompensate(journal, verify) {
  try {
    return await verify();
  } catch (error) {
    await compensateJournal(journal, error);
    throw error;
  }
}

export async function applyPlan(db, plan, hierarchy) {
  let memberWrites = 0; let preferenceWrites = 0; let edgeWrites = 0;
  const journal = [];
  try { for (const item of plan.items) {
    let member = item.member;
    const organizationWillChange = item.action === 'update' && Object.hasOwn(item.patch, 'organization_id');
    const knownActiveEdges = item.activeDepartmentEdges
      || [...(item.exactEdges || []), ...(item.conflictingEdges || [])];
    const rollbackEdges = organizationWillChange
      ? knownActiveEdges
      : (item.edgeAction === 'replace' || item.edgeAction === 'archive') ? item.conflictingEdges : [];
    if (rollbackEdges.length) {
      // Register restoration before member.organization_id changes: the live
      // organisation-change trigger can archive any active Department edge,
      // including the exact desired one.
      const originalEdges = rollbackEdges.map((edge) => ({
        id: edge.id,
        archived_at: edge.archived_at,
        archived_by: edge.archived_by ?? null,
      }));
      journal.push({
        label: `restore prior Department edges for ${member.id}`,
        rollback: async () => {
          for (const edge of originalEdges) {
            const { data: restored, error: rollbackError } = await db.from('custom_object_relationship')
              .update({ archived_at: edge.archived_at, archived_by: edge.archived_by })
              .eq('tenant_id', TENANT_ID).eq('id', edge.id)
              .select('id,archived_at,archived_by');
            check(rollbackError, 'prior Department edge restore failed');
            validateReturnedRows(restored, [edge], ['id'], 'Prior Department edge restore');
          }
        },
      });
    }
    if (item.action === 'insert') {
      const payload = { tenant_id: TENANT_ID, ...item.patch };
      const { data, error } = await db.from('member').insert(payload).select('*').single();
      check(error, `Could not insert Member "${item.row.email}"`);
      if (data?.id) journal.push({
        label: `delete inserted Member ${data.id}`,
        rollback: async () => {
          const { data: deleted, error: rollbackError } = await db.from('member').delete()
            .eq('tenant_id', TENANT_ID).eq('id', data.id).select('id');
          check(rollbackError, 'delete failed');
          if ((deleted || []).length !== 1 || deleted[0].id !== data.id) fail('delete did not remove exactly one inserted Member');
        },
      });
      if (!data?.id || data.tenant_id !== TENANT_ID || emailKey(data.email) !== item.row.email) fail('Member insert returned an unexpected row.');
      member = data; memberWrites += 1;
    } else if (item.action === 'update') {
      const before = Object.fromEntries(Object.keys(item.patch).map((key) => [key, member[key]]));
      journal.push({
        label: `restore Member ${member.id}`,
        rollback: async () => {
          const { data: restored, error: rollbackError } = await db.from('member').update(before)
            .eq('tenant_id', TENANT_ID).eq('id', member.id).select('id');
          check(rollbackError, 'restore failed');
          if ((restored || []).length !== 1 || restored[0].id !== member.id) fail('restore did not update exactly one Member');
        },
      });
      const { data, error } = await db.from('member').update(item.patch).eq('tenant_id', TENANT_ID).eq('id', member.id).select('*').single();
      check(error, `Could not update Member "${item.row.email}"`);
      if (data?.id !== member.id || data.tenant_id !== TENANT_ID) fail('Member update returned an unexpected row.');
      member = data; memberWrites += 1;
    }
    const exactEdge = (item.exactEdges || [])[0];
    if (organizationWillChange && exactEdge) {
      const { data: currentExact, error: readError } = await db.from('custom_object_relationship')
        .select('id,archived_at,archived_by').eq('tenant_id', TENANT_ID).eq('id', exactEdge.id);
      check(readError, `Could not re-read exact Department member edge for "${item.row.email}"`);
      if ((currentExact || []).length !== 1) fail(`Exact Department member edge disappeared for "${item.row.email}".`);
      if (currentExact[0].archived_at != null) {
        const expected = { id: exactEdge.id, archived_at: exactEdge.archived_at, archived_by: exactEdge.archived_by ?? null };
        const { data: restored, error: restoreError } = await db.from('custom_object_relationship')
          .update({ archived_at: expected.archived_at, archived_by: expected.archived_by })
          .eq('tenant_id', TENANT_ID).eq('id', expected.id).select('id,archived_at,archived_by');
        check(restoreError, `Could not restore exact Department member edge for "${item.row.email}"`);
        validateReturnedRows(restored, [expected], ['id'], 'Exact Department edge restore');
        edgeWrites += 1;
      }
    }
    const prefWrites = item.preferences.filter((pref) => pref.action !== 'unchanged').map((pref) => ({
      member_id: member.id, field_id: pref.mapping.id, value: pref.desired,
    }));
    if (prefWrites.length) {
      const preferenceBefore = item.preferences.filter((pref) => pref.action !== 'unchanged').map((pref) => ({
        memberId: member.id, fieldId: pref.mapping.id, existing: pref.existing,
      }));
      journal.push({
        label: `restore preferences for ${member.id}`,
        rollback: async () => {
          for (const previous of preferenceBefore) {
            if (previous.existing) {
              const { data: restored, error: rollbackError } = await db.from('member_preference_value')
                .upsert({ member_id: previous.memberId, field_id: previous.fieldId, value: previous.existing.value }, { onConflict: 'member_id,field_id' })
                .select('member_id,field_id');
              check(rollbackError, 'preference restore failed');
              validateReturnedRows(restored, [{ member_id: previous.memberId, field_id: previous.fieldId }], ['member_id', 'field_id'], 'Preference restore');
            } else {
              const { data: deleted, error: rollbackError } = await db.from('member_preference_value').delete()
                .eq('member_id', previous.memberId).eq('field_id', previous.fieldId).select('member_id,field_id');
              check(rollbackError, 'preference delete failed');
              if ((deleted || []).length > 1) fail('preference delete removed more than one row');
            }
          }
        },
      });
      const { data, error } = await db.from('member_preference_value').upsert(prefWrites, { onConflict: 'member_id,field_id' }).select('member_id,field_id,value');
      check(error, `Could not write preferences for "${item.row.email}"`);
      validateReturnedRows(data, prefWrites, ['member_id', 'field_id'], 'Preference upsert');
      preferenceWrites += prefWrites.length;
    }
    if (item.edgeAction === 'replace' || item.edgeAction === 'archive') {
      const conflictIds = item.conflictingEdges.map((edge) => edge.id);
      // Updating member.organization_id may already archive these edges through
      // the live organisation-change trigger. Archive only conflicts still active.
      const { data: archived, error } = await db.from('custom_object_relationship')
        .update({ archived_at: new Date().toISOString() })
        .eq('tenant_id', TENANT_ID).in('id', conflictIds).is('archived_at', null)
        .select('id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at');
      check(error, `Could not archive prior Department member edge for "${item.row.email}"`);
      const { data: stillActive, error: verifyError } = await db.from('custom_object_relationship')
        .select('id').eq('tenant_id', TENANT_ID).in('id', conflictIds).is('archived_at', null);
      check(verifyError, `Could not verify prior Department member edges for "${item.row.email}"`);
      if (stillActive?.length) {
        fail(`Could not archive ${stillActive.length} prior Department member edge(s) for "${item.row.email}".`);
      }
      edgeWrites += archived?.length || 0;
    }
    if (item.edgeAction === 'insert' || item.edgeAction === 'replace') {
      const expected = { tenant_id: TENANT_ID, relationship_definition_id: hierarchy.memberDefinition.id, source_record_id: item.departmentId, target_record_id: member.id };
      const { data, error } = await db.from('custom_object_relationship').insert(expected)
        .select('id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at').single();
      check(error, `Could not create Department member edge for "${item.row.email}"`);
      if (data?.id) journal.push({
        label: `archive inserted Department edge ${data.id}`,
        rollback: async () => {
          const { data: archived, error: rollbackError } = await db.from('custom_object_relationship')
            .update({ archived_at: new Date().toISOString() })
            .eq('tenant_id', TENANT_ID).eq('id', data.id).is('archived_at', null).select('id');
          check(rollbackError, 'edge archive failed');
          if ((archived || []).length !== 1 || archived[0].id !== data.id) fail('edge archive did not affect exactly one row');
        },
      });
      if (!data?.id || data.archived_at != null || Object.entries(expected).some(([key, value]) => data[key] !== value)) fail('Department member edge insert returned an unexpected row.');
      edgeWrites += 1;
    }
  } } catch (error) {
    await compensateJournal(journal, error);
    throw error;
  }
  return { memberWrites, preferenceWrites, edgeWrites, journal };
}

function count(plan, action) { return plan.items.filter((item) => item.action === action).length; }
function report(source, state, mappings, hierarchy, plan) {
  console.log('\n--- Validated pinned source and destination ---');
  console.log(`  CSV SHA-256 / Windows-1252:       ${source.fingerprint}`);
  console.log(`  Rows / positional columns:        ${source.rows.length}/${COLUMN_COUNT}`);
  console.log(`  Existing Members matched by email:${state.members.length}/${ROW_COUNT} (unrelated BNMS Members excluded)`);
  console.log(`  Hierarchy direct/org/dept/none:   ${source.counts.directGroup}/${source.counts.organization}/${source.counts.department}/${source.counts.none}`);
  console.log(`  Unique groups/orgs/departments:   ${hierarchy.groupIds.size}/${hierarchy.organizationIds.size}/${hierarchy.departmentIds.size}`);
  console.log(`  Custom mappings / ignored cols:   ${mappings.length}/${IGNORED_COLUMNS.length}`);
  console.log('  Organisation -> Group (every AB source row):');
  for (const chain of hierarchy.organisationChains) {
    console.log(`    Row ${chain.sourceRow}: ${chain.organizationId} -> ${chain.groupId || 'UNASSIGNED (explicitly approved)'}`);
  }
  console.log('  Department -> Organisation -> Group (every AC source row):');
  for (const chain of hierarchy.departmentChains) console.log(`    Row ${chain.sourceRow}: ${chain.departmentId} -> ${chain.organizationId} -> ${chain.groupId}`);
  console.log('\n--- Planned writes ---');
  console.log(`  Members insert/update/unchanged:  ${count(plan, 'insert')}/${count(plan, 'update')}/${count(plan, 'unchanged')}`);
  console.log(`  Preferences insert/update:        ${plan.items.flatMap((x) => x.preferences).filter((x) => x.action === 'insert').length}/${plan.items.flatMap((x) => x.preferences).filter((x) => x.action === 'update').length}`);
  console.log(`  Department member edges insert:   ${plan.items.filter((x) => x.edgeAction === 'insert').length}`);
  console.log(`  Department member edges replace:  ${plan.items.filter((x) => x.edgeAction === 'replace').length}`);
  console.log(`  Stale Department edges archive:   ${plan.items.filter((x) => x.edgeAction === 'archive').length}`);
  console.log(`  No-reference rows (preserve existing; new only if nullable): ${noReferenceRows(source).map((row) => `${row.sourceRow}:${row.email}`).join(', ')}`);
  console.log('  Blank source cells:                ignored (never clear destination data)');
}

async function main() {
  const apply = process.argv.includes('--apply');
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--apply') continue;
    if (args[index] === '--file' && args[index + 1]) { index += 1; continue; }
    fail('Only --apply and --file <protected CSV path> are supported; no --apply performs a dry run.');
  }
  console.log(`\n=== BNMS direct-debit Member import (${apply ? 'APPLY' : 'DRY RUN — NO WRITES'}) ===`);
  const source = readSource(sourceFileFromArgs(args));
  const db = destinationClient();
  const state = await loadState(db, source);
  let mappings; let hierarchy;
  const blockers = [];
  try { mappings = auditMappings(state.fields, source); } catch (error) { blockers.push(error.message); }
  try { hierarchy = auditHierarchy(source, state); } catch (error) { blockers.push(error.message); }
  if (!state.memberSupportsOrganizationGroup) {
    blockers.push('Destination Member schema is missing required member.organization_group_id for the 101 direct Organisation Group assignments.');
  }
  if (blockers.length) fail(`Destination audit blocked (${blockers.length} issue${blockers.length === 1 ? '' : 's'}): ${blockers.join(' | ')}`);
  const plan = makePlan(source, state, mappings, hierarchy);
  auditNoReferenceEligibility(source, state, plan);
  report(source, state, mappings, hierarchy, plan);
  if (!apply) return console.log('\n=== DRY RUN complete: no database rows modified ===\n');
  const before = await preservationSnapshot(db, source, mappings, hierarchy);
  const result = await applyPlan(db, plan, hierarchy);
  const exactActiveEdges = await verifyOrCompensate(result.journal, async () => {
    const verifiedState = await loadState(db, source);
    const verifiedMappings = auditMappings(verifiedState.fields, source);
    const verifiedHierarchy = auditHierarchy(source, verifiedState);
    const replay = makePlan(source, verifiedState, verifiedMappings, verifiedHierarchy);
    auditNoReferenceEligibility(source, verifiedState, replay);
    const pending = replay.items.filter((item) => item.action !== 'unchanged'
      || item.preferences.some((pref) => pref.action !== 'unchanged')
      || !['none', 'unchanged'].includes(item.edgeAction));
    const sourceEmailSet = new Set(source.rows.map((row) => row.email));
    if (verifiedState.members.length !== ROW_COUNT
      || verifiedState.members.some((member) => !sourceEmailSet.has(emailKey(member.email)))
      || pending.length) fail(`Post-import replay verification failed: ${pending.length} rows still propose writes.`);
    const verifiedEdges = replay.items.filter((item) => item.departmentId).filter((item) => item.edgeAction === 'unchanged').length;
    if (verifiedEdges !== ASSIGNMENT_COUNTS.department) fail(`Expected exactly ${ASSIGNMENT_COUNTS.department} Department member relationships; found ${verifiedEdges}.`);
    if (before.digest !== (await preservationSnapshot(db, source, verifiedMappings, verifiedHierarchy, before.memberIds)).digest) {
      fail('Preservation verification failed: unrelated source member data, preferences, or out-of-source relevant records changed.');
    }
    return verifiedEdges;
  });
  console.log(`\nApplied ${result.memberWrites} Member, ${result.preferenceWrites} preference, and ${result.edgeWrites} relationship writes.`);
  console.log(`Verified ${ROW_COUNT} Members and ${exactActiveEdges} Department member edges. Replay: zero writes.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`\nERROR: ${error.message}`); process.exit(1); });
}
#!/usr/bin/env node
/**
 * Dry-run-first import of the pinned BNMS student CSV.
 *
 * Usage:
 *   node scripts/import-bnms-students.mjs
 *   node scripts/import-bnms-students.mjs --apply
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import iconv from 'iconv-lite';
import {
  TENANT_ID, applyPlan, clean, emailKey, parseBritishDate, transformed,
  memberAssignmentNullability, validateReturnedRows, verifyOrCompensate,
} from './import-bnms-direct-debit-members.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'attached_assets', 'Student_data_to_import_31.08.26_1788203201487.csv');
export const EXPECTED_FILE_SHA256 = 'c39e8b287ce453a4305aeeb71ec18d3864d6d48d95cd6b64697625b30bc97d9d';
export const ROW_COUNT = 53;
export const IMPORT_ROW_COUNT = 52;
export const COLUMN_COUNT = 24;
export const ASSIGNMENT_COUNTS = Object.freeze({ organization: 52, none: 1, uniqueOrganizations: 35 });
export const COMBINATION_COUNTS = Object.freeze({
  'Student Membership|Active|Student': 47,
  'Resigned Membership|Active|Former': 5,
  'Student Membership|Active|Patient representative': 1,
});
export const HEADERS = Object.freeze([
  'YM Web Site Member ID', 'Member Since', 'YM Date Membership Expires',
  'YM Membership type', 'Membership status', 'Member class', 'First Name',
  'Last Name', 'Title', 'Email', 'Alternative email address',
  'Invoice address line 1', 'Invoice address line 2', 'Invoice city',
  'Invoice county/state', 'Invoice post/zip code', 'Invoice country', 'Region',
  'Landline', 'Mobile', 'Student course title', 'Notes', 'Organisation UUID',
  'Category - Focus Area',
]);
export const CORE_MAPPINGS = Object.freeze([
  { column: 1, destination: 'created_on', transform: 'student-date' },
  { column: 6, destination: 'first_name' },
  { column: 7, destination: 'last_name' },
  { column: 9, destination: 'email', transform: 'email' },
  { column: 18, destination: 'landline' },
  { column: 19, destination: 'mobile' },
  // This follows the already-approved BNMS positional import contract: source
  // Notes are stored in the Member core job_title column.
  { column: 21, destination: 'job_title' },
]);
export const CUSTOM_MAPPINGS = Object.freeze([
  ['50d7b71c-29b0-4d4c-a817-f39edf35f2e0', 0, 'ym_web_site_member_id', 'YM Web Site Member ID', 'text'],
  ['2f04cda8-33f9-4df4-bcd5-e7150e4ca9ae', 2, 'ym_date_membership_expires', 'YM Date Membership Expires', 'text', 'validated-date'],
  ['40bdb74f-e8e0-4ad1-9760-b1128256a752', 3, 'ym_membership_type', 'YM Membership type', 'dropdown'],
  ['388e1dfe-d917-4317-933a-0319542a7d92', 4, 'membership_status', 'Membership status', 'dropdown'],
  ['87f120ff-92e6-4d52-944b-9ba9d7b1fac0', 5, 'member_class', 'Member class', 'dropdown'],
  ['4f2e504c-1663-4dd8-a486-274159834320', 8, 'title', 'Title', 'dropdown'],
  ['b3d6ddbe-57c3-45a8-8f03-316f90b3dfbd', 10, 'alternative_email_address', 'Alternative email address', 'email'],
  ['764c4892-c12b-41bd-a9af-10a6a543f4fe', 11, 'invoice_address_line_1', 'Invoice address line 1', 'text'],
  ['61796f97-f8dc-42b1-8981-49853a1a60b5', 12, 'invoice_address_line_2', 'Invoice address line 2', 'text'],
  ['94c2d085-6cb8-41e7-a634-e6a6735b7e3e', 13, 'invoice_city', 'Invoice city', 'text'],
  ['fbc60ae4-c394-4f5e-b76a-0351499d0cf3', 14, 'invoice_county_state', 'Invoice county/state', 'text'],
  ['8983dc97-a0ed-4d81-9932-45900bca9b0b', 15, 'invoice_postcode', 'Invoice post/zip code', 'text'],
  ['6dcef4da-8c74-49fd-9d64-98bbb088af28', 16, 'invoice_country', 'Invoice country', 'country'],
  ['a55e6c86-1b33-494a-adfd-0ac6717a18da', 20, 'student_course_title', 'Student course title', 'text'],
].map(([id, column, name, label, type, transform]) => ({ id, column, name, label, type, transform })));
export const REGION_MAPPING = Object.freeze({
  column: 17, name: 'member_region', label: 'Region', type: 'dropdown', scope: 'member',
});
export const FOCUS_AREA_MAPPING = Object.freeze({
  column: 23, categoryId: '9e6a7200-1194-4e75-98d1-25a29303e95e', categoryName: 'Focus Area',
});
export const SKIPPED_LEGACY_IDS = Object.freeze(['81630031']);
export const APPROVED_TITLE_NORMALIZATIONS = Object.freeze({ 'Ms.': 'Ms', 'Mr.': 'Mr' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message) => { throw new Error(message); };
const check = (error, context) => { if (error) fail(`${context}: ${error.message}`); };

/**
 * Decode maximal valid UTF-8 sequences while decoding each otherwise-invalid
 * byte as Windows-1252. Whole-file Windows-1252 fallback is deliberately
 * forbidden because this source also contains genuine UTF-8 punctuation.
 */
export function decodeMixedEncoding(bytes) {
  let text = '';
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index];
    const width = byte < 0x80 ? 1
      : byte >= 0xc2 && byte <= 0xdf ? 2
        : byte >= 0xe0 && byte <= 0xef ? 3
          : byte >= 0xf0 && byte <= 0xf4 ? 4 : 0;
    if (width && index + width <= bytes.length) {
      try {
        text += utf8.decode(bytes.subarray(index, index + width));
        index += width;
        continue;
      } catch {
        // Decode only this invalid byte below.
      }
    }
    text += iconv.decode(bytes.subarray(index, index + 1), 'windows-1252');
    index += 1;
  }
  if (text.includes('\uFFFD') || /(?:Ã[\u0080-\u00ff]|Â[\u0080-\u00ff]|â(?:€™|€œ|€|€“|€”|[\u0080-\u00bf]))/.test(text)) {
    fail('Decoded CSV contains a replacement character or known mojibake marker.');
  }
  if (/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) {
    fail('Decoded CSV contains an unsupported control character.');
  }
  return text;
}

export function parseStudentDate(value, context = 'date') {
  const normalized = clean(value).replace(/ 00:00$/, '');
  if (normalized !== clean(value) && !/^\d{1,2}\/\d{1,2}\/\d{4} 00:00$/.test(clean(value))) {
    fail(`Invalid ${context} "${value}".`);
  }
  return parseBritishDate(normalized, context);
}

function studentTransformed(value, transform, context) {
  if (transform === 'student-date') return parseStudentDate(value, context);
  return transformed(value, transform, context);
}

export function parseSourceBytes(bytes, { verifyFingerprint = true } = {}) {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (verifyFingerprint && fingerprint !== EXPECTED_FILE_SHA256) {
    fail(`CSV fingerprint mismatch; expected ${EXPECTED_FILE_SHA256}, found ${fingerprint}.`);
  }
  const grid = parse(decodeMixedEncoding(bytes), { bom: true, relax_column_count: false, skip_empty_lines: true });
  if (!grid.length || grid[0].length !== COLUMN_COUNT
    || grid[0].some((value, index) => clean(value) !== HEADERS[index])) {
    fail(`CSV must have the exact ${COLUMN_COUNT}-column positional header contract.`);
  }
  const rows = grid.slice(1).map((input, index) => {
    const sourceRow = index + 2;
    if (input.length !== COLUMN_COUNT) fail(`CSV row ${sourceRow} must contain exactly ${COLUMN_COUNT} columns; found ${input.length}.`);
    const values = input.map(clean);
    if (!values.some(Boolean)) return null;
    if (!values[0]) fail(`CSV row ${sourceRow} has blank YM Web Site Member ID.`);
    if (!values[6] || !values[7]) fail(`CSV row ${sourceRow} has a blank required name.`);
    if (!values[9] || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values[9])) fail(`CSV row ${sourceRow} has invalid Email "${values[9]}".`);
    parseStudentDate(values[1], `Member Since at row ${sourceRow}`);
    if (values[2]) parseBritishDate(values[2], `membership expiry at row ${sourceRow}`);
    if (values[22] && !UUID_RE.test(values[22])) fail(`CSV row ${sourceRow} has invalid Organisation UUID.`);
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
  const combinations = Object.fromEntries(Object.keys(COMBINATION_COUNTS).map((key) => [key, 0]));
  for (const row of rows) {
    const key = [3, 4, 5].map((column) => row.values[column]).join('|');
    if (!(key in combinations)) fail(`Unapproved membership type/status/class combination at row ${row.sourceRow}: ${key}.`);
    combinations[key] += 1;
  }
  if (Object.keys(combinations).some((key) => combinations[key] !== COMBINATION_COUNTS[key])) {
    fail(`Membership type/status/class combination counts drifted: ${JSON.stringify(combinations)}.`);
  }
  const counts = {
    organization: rows.filter((row) => row.values[22]).length,
    none: rows.filter((row) => !row.values[22]).length,
    uniqueOrganizations: new Set(rows.map((row) => row.values[22]).filter(Boolean)).size,
  };
  if (Object.keys(counts).some((key) => counts[key] !== ASSIGNMENT_COUNTS[key])) fail(`Hierarchy source counts drifted: ${JSON.stringify(counts)}.`);
  return { rows, fingerprint, counts, combinations };
}
export function readSource(file = FILE) { return parseSourceBytes(readFileSync(file)); }

export function prepareApprovedSource(source) {
  const skipped = source.rows.filter((row) => SKIPPED_LEGACY_IDS.includes(row.legacyId));
  if (skipped.length !== 1 || skipped[0].sourceRow !== 21
    || skipped[0].values[22] !== '55b65591-6a02-4370-9805-c0c720924d79') {
    fail('Reviewed record-21 exclusion contract drifted.');
  }
  const normalized = [];
  const rows = source.rows.filter((row) => !SKIPPED_LEGACY_IDS.includes(row.legacyId)).map((row) => {
    const replacement = APPROVED_TITLE_NORMALIZATIONS[row.values[8]];
    if (!replacement) return row;
    normalized.push({ sourceRow: row.sourceRow, from: row.values[8], to: replacement });
    const values = [...row.values];
    values[8] = replacement;
    return { ...row, values };
  });
  if (rows.length !== IMPORT_ROW_COUNT
    || JSON.stringify(normalized) !== JSON.stringify([
      { sourceRow: 25, from: 'Ms.', to: 'Ms' },
      { sourceRow: 37, from: 'Mr.', to: 'Mr' },
    ])) fail('Reviewed title-normalization contract drifted.');
  return {
    ...source, rows, skipped, normalized,
    counts: {
      organization: rows.filter((row) => row.values[22]).length,
      none: rows.filter((row) => !row.values[22]).length,
      uniqueOrganizations: new Set(rows.map((row) => row.values[22]).filter(Boolean)).size,
    },
  };
}

function auditField(contract, fields, source, { requirePinnedId = true } = {}) {
  const candidates = fields.filter((field) => field.entity_scope === 'member'
    && ((contract.id && field.id === contract.id)
      || field.name === contract.name || field.label === contract.label));
  if (candidates.length !== 1) fail(`Expected one unambiguous live member field for "${contract.label}"; found ${candidates.length}.`);
  const field = candidates[0];
  if ((requirePinnedId && field.id !== contract.id) || field.tenant_id !== TENANT_ID
    || field.entity_scope !== 'member' || field.name !== contract.name
    || field.label !== contract.label || field.field_type !== contract.type || field.is_active !== true) {
    fail(`Live member field contract drifted or has wrong scope for "${contract.label}".`);
  }
  const requested = [...new Set(source.rows.map((row) => row.values[contract.column]).filter(Boolean))];
  if (contract.type === 'dropdown') {
    const allowed = new Set((field.options || []).flatMap((option) => [clean(option?.value), clean(option?.label)]).filter(Boolean));
    const unsupported = requested.filter((value) => !allowed.has(value));
    if (unsupported.length) fail(`Unsupported "${contract.label}" value(s): ${unsupported.join(', ')}.`);
  } else if (field.options != null) fail(`Field "${contract.label}" unexpectedly has controlled options.`);
  return { ...contract, id: field.id, requested };
}
export function auditMappings(fields, source) {
  const mappings = [
    ...CUSTOM_MAPPINGS.map((contract) => auditField(contract, fields, source)),
    // There is intentionally no invented ID here. A uniquely named, active
    // member-scoped Region field must exist; an organization-scoped field fails.
    auditField(REGION_MAPPING, fields, source, { requirePinnedId: false }),
  ];
  const organizationRegion = fields.filter((field) => field.tenant_id === TENANT_ID
    && field.entity_scope === 'organization' && field.name === 'region' && field.label === 'Region');
  if (organizationRegion.length !== 1 || organizationRegion[0].field_type !== 'dropdown'
    || organizationRegion[0].is_active !== true) {
    fail(`Expected one active BNMS organisation-scoped Region dropdown; found ${organizationRegion.length}.`);
  }
  const memberRegion = mappings.find((mapping) => mapping.name === REGION_MAPPING.name);
  const liveMemberRegion = fields.find((field) => field.id === memberRegion.id);
  if (JSON.stringify(liveMemberRegion.options || []) !== JSON.stringify(organizationRegion[0].options || [])) {
    fail('Member Region options are not an exact clone of the organisation Region options.');
  }
  return mappings;
}

export function auditFocusArea(categories, source) {
  const candidates = (categories || []).filter((category) => category.id === FOCUS_AREA_MAPPING.categoryId
    || category.name === FOCUS_AREA_MAPPING.categoryName);
  if (candidates.length !== 1) fail(`Expected one unambiguous live "${FOCUS_AREA_MAPPING.categoryName}" resource category; found ${candidates.length}.`);
  const category = candidates[0];
  if (category.id !== FOCUS_AREA_MAPPING.categoryId || category.tenant_id !== TENANT_ID
    || category.name !== FOCUS_AREA_MAPPING.categoryName || category.is_active !== true) {
    fail('Live Focus Area resource category contract drifted.');
  }
  const allowed = new Set((category.subcategories || []).map(clean).filter(Boolean));
  const requested = new Set();
  for (const row of source.rows) {
    for (const value of row.values[23].split('|').map(clean).filter(Boolean)) requested.add(value);
  }
  const unsupported = [...requested].filter((value) => !allowed.has(value));
  if (unsupported.length) fail(`Unsupported Focus Area value(s): ${unsupported.join(', ')}. Values are never canonicalized automatically.`);
  return { ...FOCUS_AREA_MAPPING, requested: [...requested] };
}

export function auditHierarchy(source, state) {
  const organizations = new Map((state.organizations || []).map((row) => [row.id, row]));
  const chains = [];
  const failures = [];
  for (const row of source.rows.filter((item) => item.values[22])) {
    const organization = organizations.get(row.values[22]);
    if (organization?.tenant_id !== TENANT_ID) {
      failures.push(`Row ${row.sourceRow}: Organisation ${row.values[22]} is missing or outside BNMS.`);
      continue;
    }
    chains.push({
      sourceRow: row.sourceRow,
      organizationId: organization.id,
      groupId: organization.organization_group_id || null,
      approvedParentless: !organization.organization_group_id,
    });
  }
  if (failures.length) fail(`Organisation hierarchy audit failed for ${failures.length} source row(s):\n${failures.join('\n')}`);
  return { chains };
}

const sameValue = (actual, desired) => clean(actual) === clean(desired);
export function makePlan(source, state, mappings, hierarchy, focusArea) {
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
  const categoryGroups = new Map();
  for (const value of state.memberCategories || []) {
    const key = `${value.member_id}|${value.resource_category_id}|${clean(value.subcategory_name)}`;
    categoryGroups.set(key, [...(categoryGroups.get(key) || []), value]);
  }
  return { items: source.rows.map((row) => {
    const member = membersByEmail.get(row.email) || null;
    const patch = {};
    for (const mapping of CORE_MAPPINGS) {
      const raw = row.values[mapping.column];
      if (!raw) continue;
      const desired = studentTransformed(raw, mapping.transform, `${mapping.destination} at row ${row.sourceRow}`);
      const matches = mapping.transform === 'student-date'
        ? clean(member?.[mapping.destination]).slice(0, 10) === desired
        : member && sameValue(member[mapping.destination], desired);
      if (!matches) patch[mapping.destination] = desired;
    }
    const organizationId = row.values[22] || null;
    if (organizationId && member?.organization_id !== organizationId) patch.organization_id = organizationId;
    const preferences = mappings.flatMap((mapping) => {
      const raw = row.values[mapping.column];
      if (!raw) return [];
      const desired = String(studentTransformed(raw, mapping.transform, `${mapping.label} at row ${row.sourceRow}`));
      const existing = member ? (preferenceGroups.get(`${member.id}|${mapping.id}`) || []) : [];
      if (existing.length > 1) fail(`Duplicate preference values for "${row.email}", field "${mapping.label}".`);
      return [{ mapping, desired, existing: existing[0] || null, action: !existing.length ? 'insert' : sameValue(existing[0].value, desired) ? 'unchanged' : 'update' }];
    });
    const focusAreas = row.values[23].split('|').map(clean).filter(Boolean).map((name) => {
      const existing = member ? (categoryGroups.get(`${member.id}|${focusArea.categoryId}|${name}`) || []) : [];
      if (existing.length > 1) fail(`Duplicate Focus Area "${name}" for "${row.email}".`);
      return { name, existing: existing[0] || null, action: existing.length ? 'unchanged' : 'insert' };
    });
    return {
      row, member, patch, action: member ? (Object.keys(patch).length ? 'update' : 'unchanged') : 'insert',
      preferences, focusAreas, departmentId: null, edgeAction: 'none',
      conflictingEdges: [], exactEdges: [], activeDepartmentEdges: [],
    };
  }) };
}
export const noReferenceRows = (source) => source.rows.filter((row) => !row.values[22])
  .map((row) => ({ sourceRow: row.sourceRow, email: row.email }));
export function auditNoReferenceEligibility(source, state, plan) {
  const newNoReference = plan.items.filter((item) => !item.member && !item.row.values[22]);
  if (!newNoReference.length) return;
  const nullable = state.memberAssignmentNullability;
  if (!nullable?.organization_id || !nullable?.organization_group_id) {
    fail(`Rows ${newNoReference.map((item) => item.row.sourceRow).join(', ')} have no Organisation and cannot be inserted until member.organization_id and member.organization_group_id are confirmed nullable.`);
  }
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
  const organizationIds = [...new Set(source.rows.map((row) => row.values[22]).filter(Boolean))];
  const [tenantResult, fields, categories, groups, organizations, allMembers, assignmentNullability] = await Promise.all([
    db.from('tenant').select('id,name').eq('id', TENANT_ID).maybeSingle(),
    fetchAll(db, 'preference_field', 'id,tenant_id,name,label,field_type,entity_scope,is_active,options', (q) => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'resource_category', 'id,tenant_id,name,subcategories,is_active', (q) => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'organization_group', 'id,tenant_id,name', (q) => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'organization', 'id,tenant_id,name,organization_group_id', (q) => q.in('id', organizationIds)),
    fetchAll(db, 'member', 'id,tenant_id,email,first_name,last_name,created_on,landline,mobile,job_title,organization_id', (q) => q.eq('tenant_id', TENANT_ID)),
    memberAssignmentNullability(),
  ]);
  check(tenantResult.error, 'Could not resolve pinned BNMS tenant');
  if (tenantResult.data?.id !== TENANT_ID || !/\bbnms\b|british nuclear medicine society/i.test(tenantResult.data?.name || '')) fail('Pinned destination is not BNMS.');
  const emails = new Set(source.rows.map((row) => row.email));
  const members = allMembers.filter((member) => emails.has(emailKey(member.email)));
  const memberIds = members.map((member) => member.id);
  const [preferenceValues, memberCategories] = await Promise.all([
    memberIds.length ? fetchAll(db, 'member_preference_value', 'id,member_id,field_id,value', (q) => q.in('member_id', memberIds)) : [],
    memberIds.length ? fetchAll(db, 'member_resource_category', 'id,member_id,resource_category_id,subcategory_name', (q) => q.in('member_id', memberIds).eq('resource_category_id', FOCUS_AREA_MAPPING.categoryId)) : [],
  ]);
  return {
    tenant: tenantResult.data, fields, categories, groups, organizations, members,
    preferenceValues, memberCategories, memberAssignmentNullability: assignmentNullability,
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const digest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

// Capture every row this importer must not mutate. In particular, a blank
// source cell does not make its existing destination value disposable.
export async function preservationSnapshot(db, source, mappings, originalIds = null, immutableEmails = new Set()) {
  const allMembers = await fetchAll(db, 'member', '*', (q) => q.eq('tenant_id', TENANT_ID));
  const emails = new Set(source.rows.map((row) => row.email));
  const sourceMembers = allMembers.filter((member) => emails.has(emailKey(member.email)));
  const currentIds = new Set(sourceMembers.map((member) => member.id));
  const protectedIds = originalIds || currentIds;
  const mappingById = new Map(mappings.map((mapping) => [mapping.id, mapping]));
  const sourceByEmail = new Map(source.rows.map((row) => [row.email, row]));
  const memberById = new Map(sourceMembers.map((member) => [member.id, member]));
  const fieldIds = mappings.map((mapping) => mapping.id);
  const [prefs, targetPrefs, relationships, focusRows] = await Promise.all([
    protectedIds.size ? fetchAll(db, 'member_preference_value', '*', (q) => q.in('member_id', [...protectedIds])) : [],
    fieldIds.length ? fetchAll(db, 'member_preference_value', '*', (q) => q.in('field_id', fieldIds)) : [],
    protectedIds.size ? fetchAll(db, 'custom_object_relationship', '*', (q) => q.in('target_record_id', [...protectedIds])) : [],
    fetchAll(db, 'member_resource_category', '*', (q) => q.eq('resource_category_id', FOCUS_AREA_MAPPING.categoryId)),
  ]);
  const protectedMembers = sourceMembers.filter((member) => protectedIds.has(member.id)).map((member) => {
    const sourceRow = sourceByEmail.get(emailKey(member.email));
    const writable = new Set(['updated_at']);
    if (!immutableEmails.has(emailKey(member.email))) {
      for (const mapping of CORE_MAPPINGS) {
        if (sourceRow?.values[mapping.column]) writable.add(mapping.destination);
      }
      if (sourceRow?.values[22]) writable.add('organization_id');
    }
    return Object.fromEntries(Object.entries(member).filter(([key]) => !writable.has(key)));
  });
  const protectedPrefs = prefs.filter((pref) => {
    const mapping = mappingById.get(pref.field_id);
    const sourceRow = sourceByEmail.get(emailKey(memberById.get(pref.member_id)?.email));
    return immutableEmails.has(emailKey(memberById.get(pref.member_id)?.email))
      || !mapping || !sourceRow || !sourceRow.values[mapping.column];
  });
  const managedFocusIds = new Set(source.rows.filter((row) => row.values[FOCUS_AREA_MAPPING.column])
    .filter((row) => !immutableEmails.has(row.email))
    .map((row) => sourceMembers.find((member) => emailKey(member.email) === row.email)?.id).filter(Boolean));
  return {
    ids: protectedIds,
    digest: digest({
      unmanagedMembers: protectedMembers,
      unrelatedPreferencesAndBlankManagedPreferences: protectedPrefs,
      mappedPreferencesOutsideSourceMembers: targetPrefs.filter((row) => !currentIds.has(row.member_id)),
      allRelationshipsForSourceMembers: relationships,
      focusOutsideManagedSourceRows: focusRows.filter((row) => !currentIds.has(row.member_id) || !managedFocusIds.has(row.member_id)),
    }),
  };
}

export async function applyStudentPlan(db, plan, hierarchy, focusArea) {
  const result = await applyPlan(db, plan, { ...hierarchy, memberDefinition: { id: 'unused' } });
  try {
    const emails = plan.items.map((item) => item.row.email);
    const members = await fetchAll(db, 'member', 'id,tenant_id,email', (q) => q.eq('tenant_id', TENANT_ID));
    const byEmail = new Map(members.filter((member) => emails.includes(emailKey(member.email))).map((member) => [emailKey(member.email), member]));
    let categoryWrites = 0;
    for (const item of plan.items) {
      const member = byEmail.get(item.row.email);
      if (!member) fail(`Could not resolve imported Member "${item.row.email}" for Focus Area writes.`);
      const writes = item.focusAreas.filter((area) => area.action === 'insert').map((area) => ({
        member_id: member.id, resource_category_id: focusArea.categoryId, subcategory_name: area.name,
      }));
      if (!writes.length) continue;
      const { data, error } = await db.from('member_resource_category').insert(writes)
        .select('id,member_id,resource_category_id,subcategory_name');
      check(error, `Could not write Focus Areas for "${item.row.email}"`);
      validateReturnedRows(data, writes, ['member_id', 'resource_category_id', 'subcategory_name'], 'Focus Area insert');
      const ids = data.map((row) => row.id);
      result.journal.push({
        label: `delete Focus Areas for ${member.id}`,
        rollback: async () => {
          const { data: deleted, error: rollbackError } = await db.from('member_resource_category')
            .delete().in('id', ids).select('id');
          check(rollbackError, 'Focus Area delete failed');
          if ((deleted || []).length !== ids.length) fail('Focus Area delete did not remove every inserted row.');
        },
      });
      categoryWrites += writes.length;
    }
    return { ...result, categoryWrites };
  } catch (error) {
    await verifyOrCompensate(result.journal, async () => { throw error; });
    throw error;
  }
}

function report(rawSource, source, state, mappings, hierarchy, focusArea, plan) {
  const count = (action) => plan.items.filter((item) => item.action === action).length;
  console.log('\n--- Validated pinned source and destination ---');
  console.log(`  CSV SHA-256 / raw/import rows:     ${source.fingerprint} / ${rawSource.rows.length}/${source.rows.length}`);
  console.log(`  Existing Members matched by email:${state.members.length}/${IMPORT_ROW_COUNT}`);
  console.log(`  Hierarchy org/none/unique orgs:   ${source.counts.organization}/${source.counts.none}/${source.counts.uniqueOrganizations}`);
  console.log(`  Approved core/custom mappings:    ${CORE_MAPPINGS.length}/${mappings.length}`);
  console.log(`  Focus Area category/values:       ${focusArea.categoryId}/${focusArea.requested.length}`);
  for (const chain of hierarchy.chains) console.log(`  Row ${chain.sourceRow}: Organisation ${chain.organizationId}${chain.groupId ? ` -> Group ${chain.groupId}` : ' (parentless, explicitly approved)'}`);
  console.log(`  Skipped reviewed record:          ${source.skipped.map((row) => `${row.sourceRow}:${row.email}`).join(', ')}`);
  console.log(`  Approved title normalizations:    ${source.normalized.map((item) => `${item.sourceRow}:${item.from}->${item.to}`).join(', ')}`);
  console.log('\n--- Planned field-level changes ---');
  console.log(`  Members insert/update/unchanged:  ${count('insert')}/${count('update')}/${count('unchanged')}`);
  for (const item of plan.items) {
    const prefs = item.preferences.filter((pref) => pref.action !== 'unchanged').length;
    const areas = item.focusAreas.filter((area) => area.action !== 'unchanged').length;
    console.log(`  Row ${item.row.sourceRow} ${item.row.email}: ${item.action}; ${Object.keys(item.patch).length} core, ${prefs} preference, ${areas} Focus Area writes`);
  }
  console.log(`  No Organisation supplied (preserved, never guessed): ${noReferenceRows(source).map((row) => `${row.sourceRow}:${row.email}`).join(', ')}`);
  console.log('  Blank source cells: preserved; communications/workflows/finance/login: untouched');
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some((arg) => arg !== '--apply')) fail('Only --apply is supported; no --apply performs a dry run.');
  console.log(`\n=== BNMS student Member import (${apply ? 'APPLY' : 'DRY RUN — NO WRITES'}) ===`);
  const rawSource = readSource();
  const source = prepareApprovedSource(rawSource);
  const db = destinationClient();
  const state = await loadState(db, source);
  const mappings = auditMappings(state.fields, source);
  const focusArea = auditFocusArea(state.categories, source);
  const hierarchy = auditHierarchy(source, state);
  const plan = makePlan(source, state, mappings, hierarchy, focusArea);
  auditNoReferenceEligibility(source, state, plan);
  report(rawSource, source, state, mappings, hierarchy, focusArea, plan);
  if (!apply) return console.log('\n=== DRY RUN complete: no database rows modified ===\n');
  const protectedSource = { ...source, rows: [...source.rows, ...source.skipped] };
  const immutableEmails = new Set(source.skipped.map((row) => row.email));
  const before = await preservationSnapshot(db, protectedSource, mappings, null, immutableEmails);
  const result = await applyStudentPlan(db, plan, hierarchy, focusArea);
  await verifyOrCompensate(result.journal, async () => {
    const verified = await loadState(db, source);
    const verifiedMappings = auditMappings(verified.fields, source);
    const verifiedFocus = auditFocusArea(verified.categories, source);
    const verifiedHierarchy = auditHierarchy(source, verified);
    const replay = makePlan(source, verified, verifiedMappings, verifiedHierarchy, verifiedFocus);
    const pending = replay.items.filter((item) => item.action !== 'unchanged'
      || item.preferences.some((pref) => pref.action !== 'unchanged')
      || item.focusAreas.some((area) => area.action !== 'unchanged'));
    if (verified.members.length !== IMPORT_ROW_COUNT || pending.length) fail(`Post-import replay verification failed: ${pending.length} rows still propose writes.`);
    const after = await preservationSnapshot(db, protectedSource, verifiedMappings, before.ids, immutableEmails);
    if (before.digest !== after.digest) fail('Preservation verification failed: unmanaged, blank, unrelated, or outside Focus Area data changed.');
  });
  console.log(`\nApplied ${result.memberWrites} Member, ${result.preferenceWrites} preference, and ${result.categoryWrites} Focus Area writes. Replay: zero writes.\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`\nERROR: ${error.message}`); process.exit(1); });
}
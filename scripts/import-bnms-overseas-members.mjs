#!/usr/bin/env node
/**
 * Dry-run-first import of the pinned BNMS overseas-member workbook.
 *
 * Usage:
 *   node scripts/import-bnms-overseas-members.mjs
 *   node scripts/import-bnms-overseas-members.mjs --apply
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import {
  TENANT_ID, applyPlan, clean, emailKey, memberAssignmentNullability,
  parseBritishDate, transformed, validateReturnedRows, verifyOrCompensate,
} from './import-bnms-direct-debit-members.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'attached_assets', 'Overseas_to_import_03.09.26_v2_1788452880216.xlsx');
export const EXPECTED_FILE_SHA256 = 'a73c77c7141573e04ed5767648555d59b4ac12a55003d59107d174ac3ab08cea';
export const ROW_COUNT = 36;
export const COLUMN_COUNT = 24;
export const HEADERS = Object.freeze([
  'ym_web_site_member_id', 'Member Since', 'membership_status',
  'ym_date_membership_expires', 'ym_membership_type', 'member_class',
  'nmc_address_line_1', 'nmc_address_line_2', 'nmc_address_line_3',
  'nmc_address_city', 'nmc_address_zip', 'nmc_address_country',
  'First name', 'Last name', 'Title', 'Email', 'alternative_email_address',
  'Phone', 'member_region', 'Organisation UUID', 'occupation', 'qualifications',
  'srp/irpa_affiliate', 'Category - Focus Area',
]);
export const CORE_MAPPINGS = Object.freeze([
  { column: 1, destination: 'created_on', transform: 'date' },
  { column: 12, destination: 'first_name' },
  { column: 13, destination: 'last_name' },
  { column: 15, destination: 'email', transform: 'email' },
  { column: 17, destination: 'mobile' },
]);
export const CUSTOM_MAPPINGS = Object.freeze([
  ['50d7b71c-29b0-4d4c-a817-f39edf35f2e0', 0, 'ym_web_site_member_id', 'YM Web Site Member ID', 'text'],
  ['388e1dfe-d917-4317-933a-0319542a7d92', 2, 'membership_status', 'Membership status', 'dropdown'],
  ['2f04cda8-33f9-4df4-bcd5-e7150e4ca9ae', 3, 'ym_date_membership_expires', 'YM Date Membership Expires', 'text', 'validated-date'],
  ['40bdb74f-e8e0-4ad1-9760-b1128256a752', 4, 'ym_membership_type', 'YM Membership type', 'dropdown'],
  ['87f120ff-92e6-4d52-944b-9ba9d7b1fac0', 5, 'member_class', 'Member class', 'dropdown'],
  ['706a4182-25f8-48a0-9642-3bb48b1cc075', 6, 'nmc_address_line_1', 'NMC address line 1', 'text'],
  ['56e237ec-d10b-446a-8356-87e738fcbeb1', 7, 'nmc_address_line_2', 'NMC address line 2', 'text'],
  ['96032fb1-34b1-45c1-a4ad-129fcc82eed1', 8, 'nmc_address_line_3', 'NMC address line 3', 'text'],
  ['c1c73f76-c9f6-4f13-bf21-e6ae4220c307', 9, 'nmc_address_city', 'NMC address city', 'text'],
  ['d8fb72fa-34bb-4adf-961a-1d6c7401ec52', 10, 'nmc_address_zip', 'NMC address post/zip code', 'text'],
  ['264fdf95-bde5-4d0b-bb38-1c69b7bf78d9', 11, 'nmc_address_country', 'NMC address country', 'country'],
  ['4f2e504c-1663-4dd8-a486-274159834320', 14, 'title', 'Title', 'dropdown'],
  ['b3d6ddbe-57c3-45a8-8f03-316f90b3dfbd', 16, 'alternative_email_address', 'Alternative email address', 'email'],
  ['0e3e3b1f-5a3d-40b5-a4b5-f0761c115216', 18, 'member_region', 'Region', 'dropdown'],
  ['1c84695f-e8f8-4afd-b4be-e54f5f540a26', 20, 'occupation', 'Occupation', 'dropdown'],
  ['5a12aae9-d754-45ce-ac47-a97109a690e2', 21, 'qualifications', 'Qualifications', 'textarea'],
  ['2dcf5b2b-670d-4058-a3a6-b48c084cca39', 22, 'srp/irpa_affiliate', 'SRP/IRPA Affiliate', 'boolean', 'boolean'],
].map(([id, column, name, label, type, transform]) => ({ id, column, name, label, type, transform })));
export const FOCUS_AREA = Object.freeze({
  column: 23, id: '9e6a7200-1194-4e75-98d1-25a29303e95e', name: 'Focus Area',
});
export const APPROVED_NORMALIZATIONS = Object.freeze({
  member_class: Object.freeze({ 'Overseas Associate': 'Overseas associate' }),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?\d{6,15}$/;
const fail = (message) => { throw new Error(message); };
const check = (error, context) => { if (error) fail(`${context}: ${error.message}`); };

export function parseSourceBytes(bytes, { verifyFingerprint = true } = {}) {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (verifyFingerprint && fingerprint !== EXPECTED_FILE_SHA256) {
    fail(`Workbook fingerprint mismatch; expected ${EXPECTED_FILE_SHA256}, found ${fingerprint}.`);
  }
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false, raw: false });
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== 'Overseas Members') {
    fail('Workbook must contain exactly the "Overseas Members" sheet.');
  }
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets['Overseas Members'], {
    header: 1, raw: false, defval: '', blankrows: false,
  });
  if (!grid.length || grid[0].length !== COLUMN_COUNT
    || grid[0].some((value, index) => clean(value) !== HEADERS[index])) {
    fail(`Workbook must have the exact ${COLUMN_COUNT}-column positional header contract.`);
  }
  const rows = grid.slice(1).map((input, index) => {
    const sourceRow = index + 2;
    const values = Array.from({ length: COLUMN_COUNT }, (_, column) => clean(input[column]));
    values[5] = APPROVED_NORMALIZATIONS.member_class[values[5]] || values[5];
    if (!values.some(Boolean)) return null;
    if (!values[0]) fail(`Row ${sourceRow} has a blank YM Web Site Member ID.`);
    if (!values[12] || !values[13]) fail(`Row ${sourceRow} has a blank required name.`);
    if (!EMAIL_RE.test(values[15])) fail(`Row ${sourceRow} has invalid Email "${values[15]}".`);
    parseBritishDate(values[1], `Member Since at row ${sourceRow}`);
    parseBritishDate(values[3], `membership expiry at row ${sourceRow}`);
    if (values[17] && !PHONE_RE.test(values[17])) fail(`Row ${sourceRow} has malformed Phone "${values[17]}".`);
    if (values[19] && !UUID_RE.test(values[19])) fail(`Row ${sourceRow} has invalid Organisation UUID.`);
    if (!['TRUE', 'FALSE'].includes(values[22])) fail(`Row ${sourceRow} has invalid SRP/IRPA Affiliate value.`);
    return { sourceRow, email: emailKey(values[15]), legacyId: values[0], values };
  }).filter(Boolean);
  if (rows.length !== ROW_COUNT) fail(`Workbook must contain exactly ${ROW_COUNT} populated rows; found ${rows.length}.`);
  for (const [key, label] of [['email', 'normalized Email'], ['legacyId', 'YM Web Site Member ID']]) {
    const seen = new Map();
    for (const row of rows) {
      if (seen.has(row[key])) fail(`Duplicate ${label} at rows ${seen.get(row[key])} and ${row.sourceRow}.`);
      seen.set(row[key], row.sourceRow);
    }
  }
  return {
    rows, fingerprint,
    counts: {
      organization: rows.filter((row) => row.values[19]).length,
      none: rows.filter((row) => !row.values[19]).length,
      uniqueOrganizations: new Set(rows.map((row) => row.values[19]).filter(Boolean)).size,
    },
  };
}
export function readSource(file = FILE) { return parseSourceBytes(readFileSync(file)); }

export function auditMappings(fields, source) {
  return CUSTOM_MAPPINGS.map((contract) => {
    const candidates = fields.filter((field) => field.id === contract.id || field.name === contract.name);
    if (candidates.length !== 1) fail(`Expected one live field for "${contract.label}"; found ${candidates.length}.`);
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

export function auditFocusArea(categories, source) {
  const candidates = categories.filter((category) => category.id === FOCUS_AREA.id || category.name === FOCUS_AREA.name);
  if (candidates.length !== 1) fail(`Expected one live "${FOCUS_AREA.name}" category; found ${candidates.length}.`);
  const category = candidates[0];
  if (category.id !== FOCUS_AREA.id || category.tenant_id !== TENANT_ID || category.name !== FOCUS_AREA.name || category.is_active !== true) {
    fail('Live Focus Area category contract drifted.');
  }
  const requested = [...new Set(source.rows.flatMap((row) => row.values[FOCUS_AREA.column].split('|').map(clean).filter(Boolean)))];
  const allowed = new Set((category.subcategories || []).map(clean));
  const unsupported = requested.filter((value) => !allowed.has(value));
  if (unsupported.length) fail(`Unsupported Focus Area value(s): ${unsupported.join(', ')}.`);
  return { ...FOCUS_AREA, requested };
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
  const organizationIds = [...new Set(source.rows.map((row) => row.values[19]).filter(Boolean))];
  const [tenantResult, fields, categories, organizations, allMembers, nullability] = await Promise.all([
    db.from('tenant').select('id,name').eq('id', TENANT_ID).maybeSingle(),
    fetchAll(db, 'preference_field', 'id,tenant_id,name,label,field_type,entity_scope,is_active,options', (q) => q.eq('tenant_id', TENANT_ID).eq('entity_scope', 'member')),
    fetchAll(db, 'resource_category', 'id,tenant_id,name,subcategories,is_active', (q) => q.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'organization', 'id,tenant_id,name', (q) => q.in('id', organizationIds)),
    fetchAll(db, 'member', 'id,tenant_id,email,first_name,last_name,created_on,mobile,organization_id', (q) => q.eq('tenant_id', TENANT_ID)),
    memberAssignmentNullability(),
  ]);
  check(tenantResult.error, 'Could not resolve pinned BNMS tenant');
  if (tenantResult.data?.id !== TENANT_ID || !/\bbnms\b|british nuclear medicine society/i.test(tenantResult.data?.name || '')) fail('Pinned destination is not BNMS.');
  const sourceEmails = new Set(source.rows.map((row) => row.email));
  const members = allMembers.filter((member) => sourceEmails.has(emailKey(member.email)));
  const memberIds = members.map((member) => member.id);
  const [preferenceValues, memberCategories, legacyValues] = await Promise.all([
    memberIds.length ? fetchAll(db, 'member_preference_value', 'id,member_id,field_id,value', (q) => q.in('member_id', memberIds)) : [],
    memberIds.length ? fetchAll(db, 'member_resource_category', 'id,member_id,resource_category_id,subcategory_name', (q) => q.in('member_id', memberIds).eq('resource_category_id', FOCUS_AREA.id)) : [],
    fetchAll(db, 'member_preference_value', 'id,member_id,field_id,value', (q) => q.eq('field_id', CUSTOM_MAPPINGS[0].id).in('value', source.rows.map((row) => row.legacyId))),
  ]);
  return { tenant: tenantResult.data, fields, categories, organizations, members, preferenceValues, memberCategories, legacyValues, nullability };
}

const same = (actual, desired) => clean(actual) === clean(desired);
export function makePlan(source, state, mappings, focusArea) {
  const organizations = new Map();
  for (const organization of state.organizations) {
    if (organizations.has(organization.id)) fail(`Duplicate destination Organisation id "${organization.id}".`);
    organizations.set(organization.id, organization);
  }
  for (const row of source.rows.filter((item) => item.values[19])) {
    if (organizations.get(row.values[19])?.tenant_id !== TENANT_ID) fail(`Row ${row.sourceRow}: Organisation is missing or outside BNMS.`);
  }
  const membersByEmail = new Map();
  for (const member of state.members) {
    const key = emailKey(member.email);
    if (membersByEmail.has(key)) fail(`Ambiguous destination Member email "${key}".`);
    membersByEmail.set(key, member);
  }
  const prefs = new Map();
  for (const value of state.preferenceValues) {
    const key = `${value.member_id}|${value.field_id}`;
    if (prefs.has(key)) fail(`Duplicate destination preference value for "${key}".`);
    prefs.set(key, value);
  }
  const areas = new Set();
  for (const value of state.memberCategories) {
    const key = `${value.member_id}|${value.resource_category_id}|${clean(value.subcategory_name)}`;
    if (areas.has(key)) fail(`Duplicate destination Focus Area for "${key}".`);
    areas.add(key);
  }
  return { items: source.rows.map((row) => {
    const member = membersByEmail.get(row.email) || null;
    const patch = {};
    for (const mapping of CORE_MAPPINGS) {
      const raw = row.values[mapping.column];
      if (!raw) continue;
      const desired = transformed(raw, mapping.transform, `${mapping.destination} at row ${row.sourceRow}`);
      const matches = mapping.transform === 'date'
        ? clean(member?.[mapping.destination]).slice(0, 10) === desired : member && same(member[mapping.destination], desired);
      if (!matches) patch[mapping.destination] = desired;
    }
    const organizationId = row.values[19] || null;
    if (organizationId && member?.organization_id !== organizationId) patch.organization_id = organizationId;
    const preferences = mappings.flatMap((mapping) => {
      const raw = row.values[mapping.column];
      if (!raw) return [];
      const desired = String(transformed(raw, mapping.transform, `${mapping.label} at row ${row.sourceRow}`));
      const existing = member ? prefs.get(`${member.id}|${mapping.id}`) : null;
      return [{ mapping, desired, existing, action: !existing ? 'insert' : same(existing.value, desired) ? 'unchanged' : 'update' }];
    });
    const focusAreas = row.values[focusArea.column].split('|').map(clean).filter(Boolean).map((name) => ({
      name, action: member && areas.has(`${member.id}|${focusArea.id}|${name}`) ? 'unchanged' : 'insert',
    }));
    return {
      row, member, patch, action: member ? (Object.keys(patch).length ? 'update' : 'unchanged') : 'insert',
      preferences, focusAreas, departmentId: null, edgeAction: 'none',
      conflictingEdges: [], exactEdges: [], activeDepartmentEdges: [],
    };
  }) };
}

export async function writeFocusAreas(db, plan, focusArea, journal) {
  const members = await fetchAll(db, 'member', 'id,tenant_id,email', (q) => q.eq('tenant_id', TENANT_ID));
  const byEmail = new Map(members.map((member) => [emailKey(member.email), member]));
  let categoryWrites = 0;
  for (const item of plan.items) {
    const member = byEmail.get(item.row.email);
    const writes = item.focusAreas.filter((area) => area.action === 'insert').map((area) => ({
      id: randomUUID(), member_id: member.id, resource_category_id: focusArea.id, subcategory_name: area.name,
    }));
    if (!writes.length) continue;
    const ids = writes.map((row) => row.id);
    journal.push({
      label: `delete Focus Areas for ${member.id}`,
      rollback: async () => {
        const { error: rollbackError } = await db.from('member_resource_category').delete().in('id', ids).select('id');
        check(rollbackError, 'Focus Area delete failed');
        const { data: remaining, error: verifyError } = await db.from('member_resource_category').select('id').in('id', ids);
        check(verifyError, 'Focus Area rollback verification failed');
        if ((remaining || []).length) fail('Focus Area rollback was incomplete.');
      },
    });
    const { data, error } = await db.from('member_resource_category').insert(writes).select('id,member_id,resource_category_id,subcategory_name');
    check(error, `Could not write Focus Areas for "${item.row.email}"`);
    validateReturnedRows(data, writes, ['id', 'member_id', 'resource_category_id', 'subcategory_name'], 'Focus Area insert');
    categoryWrites += writes.length;
  }
  return categoryWrites;
}

async function applyImport(db, plan, focusArea) {
  const result = await applyPlan(db, plan, { memberDefinition: { id: 'unused' } });
  try {
    const categoryWrites = await writeFocusAreas(db, plan, focusArea, result.journal);
    return { ...result, categoryWrites };
  } catch (error) {
    await verifyOrCompensate(result.journal, async () => { throw error; });
    throw error;
  }
}

function destinationClient() {
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required.');
  return createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
}
function pendingItems(plan) {
  return plan.items.filter((item) => item.action !== 'unchanged'
    || item.preferences.some((pref) => pref.action !== 'unchanged')
    || item.focusAreas.some((area) => area.action !== 'unchanged'));
}
function report(source, state, mappings, focusArea, plan) {
  console.log('\n--- Validated pinned source and destination ---');
  console.log(`  XLSX SHA-256 / rows / columns:    ${source.fingerprint} / ${source.rows.length} / ${COLUMN_COUNT}`);
  console.log(`  Existing Members / legacy IDs:   ${state.members.length}/${state.legacyValues.length}`);
  console.log(`  Organisation linked/none/unique: ${source.counts.organization}/${source.counts.none}/${source.counts.uniqueOrganizations}`);
  console.log(`  Approved core/custom mappings:   ${CORE_MAPPINGS.length}/${mappings.length}`);
  console.log(`  Focus Area category/values:      ${focusArea.id}/${focusArea.requested.length}`);
  console.log('\n--- Planned changes ---');
  console.log(`  Members insert/update/unchanged: ${['insert', 'update', 'unchanged'].map((action) => plan.items.filter((item) => item.action === action).length).join('/')}`);
  console.log(`  Preference writes:               ${plan.items.flatMap((item) => item.preferences).filter((item) => item.action !== 'unchanged').length}`);
  console.log(`  Focus Area writes:               ${plan.items.flatMap((item) => item.focusAreas).filter((item) => item.action !== 'unchanged').length}`);
  console.log(`  No Organisation supplied:        ${source.rows.filter((row) => !row.values[19]).map((row) => row.sourceRow).join(', ')}`);
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some((arg) => arg !== '--apply')) fail('Only --apply is supported; no --apply performs a dry run.');
  console.log(`\n=== BNMS overseas Member import (${apply ? 'APPLY' : 'DRY RUN — NO WRITES'}) ===`);
  const source = readSource();
  const db = destinationClient();
  const state = await loadState(db, source);
  const mappings = auditMappings(state.fields, source);
  const focusArea = auditFocusArea(state.categories, source);
  const plan = makePlan(source, state, mappings, focusArea);
  if (source.counts.none && (!state.nullability?.organization_id || !state.nullability?.organization_group_id)) {
    fail('Unlinked rows cannot be inserted because Member hierarchy fields were not confirmed nullable.');
  }
  report(source, state, mappings, focusArea, plan);
  if (!apply) return console.log('\n=== DRY RUN complete: no database rows modified ===\n');
  if (state.members.length || state.legacyValues.length) {
    fail('Apply requires a clean new-member import: matching email or legacy ID rows already exist.');
  }
  const result = await applyImport(db, plan, focusArea);
  await verifyOrCompensate(result.journal, async () => {
    const verified = await loadState(db, source);
    const replayMappings = auditMappings(verified.fields, source);
    const replayFocus = auditFocusArea(verified.categories, source);
    const replay = makePlan(source, verified, replayMappings, replayFocus);
    const pending = pendingItems(replay);
    if (verified.members.length !== ROW_COUNT || verified.legacyValues.length !== ROW_COUNT || pending.length) {
      fail(`Post-import replay failed: ${verified.members.length} Members, ${verified.legacyValues.length} legacy IDs, ${pending.length} pending rows.`);
    }
  });
  console.log(`\nApplied ${result.memberWrites} Members, ${result.preferenceWrites} preferences, and ${result.categoryWrites} Focus Area assignments. Replay: zero writes.\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`\nERROR: ${error.message}`); process.exit(1); });
}
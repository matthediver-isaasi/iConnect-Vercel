#!/usr/bin/env node
/**
 * Guarded, dry-run-first import for the pinned BNMS guest-member workbook.
 *
 * Usage:
 *   node scripts/import-bnms-guest-members.mjs
 *   node scripts/import-bnms-guest-members.mjs --apply
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import {
  TENANT_ID, applyPlan, clean, emailKey, memberAssignmentNullability,
  parseBritishDate, transformed, verifyOrCompensate,
} from './import-bnms-direct-debit-members.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'attached_assets', 'Guest_Members_IMPORT_WITH_UUIDs_PHONE_IMPORT_READY_06.09.26_v_1788685624571.xlsx');
export const EXPECTED_FILE_SHA256 = 'ab5ef389438d44ad3f45d84e6fe6d630344a494f11169182fa28b77a72ca04cb';
export const SHEET_NAME = 'Guest Members';
export const ROW_COUNT = 1500;
export const COLUMN_COUNT = 15;
export const ASSIGNMENT_COUNTS = Object.freeze({ group: 810, organization: 690 });
export const PRIOR_GUEST_EMAIL_OVERLAPS = Object.freeze([
  { email: 'dylanhurry@gmail.com', priorLegacyId: '74149979', incomingLegacyId: '74144337' },
  { email: 'maryantoinette.mcneil@nhs.scot', priorLegacyId: '69321893', incomingLegacyId: '79526353' },
]);
export const HEADERS = Object.freeze([
  'YM Web Site Member ID', 'Member Since', 'Membership status',
  'YM Membership type', 'Member class', 'First Name', 'Last Name', 'Title',
  'Email', 'Alternative email address', 'Phone', 'Group UUID',
  'Organisation UUID', 'Occupation', 'Qualifications',
]);
export const CORE_MAPPINGS = Object.freeze([
  { column: 1, destination: 'created_on', transform: 'date' },
  { column: 5, destination: 'first_name' },
  { column: 6, destination: 'last_name' },
  { column: 8, destination: 'email', transform: 'email' },
  { column: 10, destination: 'mobile', transform: 'phone' },
]);
export const CUSTOM_MAPPINGS = Object.freeze([
  ['50d7b71c-29b0-4d4c-a817-f39edf35f2e0', 0, 'ym_web_site_member_id', 'YM Web Site Member ID', 'text'],
  ['388e1dfe-d917-4317-933a-0319542a7d92', 2, 'membership_status', 'Membership status', 'dropdown'],
  ['40bdb74f-e8e0-4ad1-9760-b1128256a752', 3, 'ym_membership_type', 'YM Membership type', 'dropdown'],
  ['87f120ff-92e6-4d52-944b-9ba9d7b1fac0', 4, 'member_class', 'Member class', 'dropdown'],
  ['4f2e504c-1663-4dd8-a486-274159834320', 7, 'title', 'Title', 'dropdown'],
  ['b3d6ddbe-57c3-45a8-8f03-316f90b3dfbd', 9, 'alternative_email_address', 'Alternative email address', 'email'],
  ['1c84695f-e8f8-4afd-b4be-e54f5f540a26', 13, 'occupation', 'Occupation', 'dropdown'],
  ['5a12aae9-d754-45ce-ac47-a97109a690e2', 14, 'qualifications', 'Qualifications', 'textarea'],
].map(([id, column, name, label, type, transform]) => ({ id, column, name, label, type, transform })));

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Phone is deliberately treated as an opaque safe string. The pinned source
// includes one valid five-digit internal/local number; no digits are invented.
// Preserve the pinned workbook's opaque digit strings exactly. Four reviewed
// rows contain 16 digits; rejecting or shortening them would require guessing.
const PHONE_RE = /^\+?\d{5,16}$/;
const fail = (message) => { throw new Error(message); };
const check = (error, context) => { if (error) fail(`${context}: ${error.message}`); };
const xform = (value, transform, context) => {
  if (transform === 'phone') return clean(value);
  return transformed(value, transform, context);
};

export function parseSourceBytes(bytes, { verifyFingerprint = true } = {}) {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (verifyFingerprint && fingerprint !== EXPECTED_FILE_SHA256) {
    fail(`Workbook fingerprint mismatch; expected ${EXPECTED_FILE_SHA256}, found ${fingerprint}.`);
  }
  const workbook = XLSX.read(bytes, { type: 'buffer', raw: false, cellDates: false });
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== SHEET_NAME) {
    fail(`Workbook must contain exactly the "${SHEET_NAME}" sheet.`);
  }
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[SHEET_NAME], {
    header: 1, raw: false, defval: '', blankrows: false,
  });
  if (!grid.length || grid[0].length !== COLUMN_COUNT
    || grid[0].some((value, index) => clean(value) !== HEADERS[index])) {
    fail(`Workbook must have the exact ${COLUMN_COUNT}-column positional header contract.`);
  }
  const rows = grid.slice(1).map((input, index) => {
    const sourceRow = index + 2;
    if (input.length > COLUMN_COUNT) fail(`Row ${sourceRow} exceeds ${COLUMN_COUNT} columns.`);
    const values = Array.from({ length: COLUMN_COUNT }, (_, column) => clean(input[column]));
    if (!values.some(Boolean)) return null;
    if (!values[0] || !values[5] || !values[6] || !values[8]) {
      fail(`Row ${sourceRow} has a blank required legacy ID, name, or email.`);
    }
    parseBritishDate(values[1], `Member Since at row ${sourceRow}`);
    if (!EMAIL_RE.test(values[8])) fail(`Row ${sourceRow} has invalid Email "${values[8]}".`);
    if (values[9] && !EMAIL_RE.test(values[9])) fail(`Row ${sourceRow} has invalid Alternative email address.`);
    if (values[10] && !PHONE_RE.test(values[10])) fail(`Row ${sourceRow} has unsafe Phone "${values[10]}".`);
    if ([11, 12].filter((column) => values[column]).length !== 1) {
      fail(`Row ${sourceRow} must have exactly one Group UUID or Organisation UUID.`);
    }
    for (const column of [11, 12]) {
      if (values[column] && !UUID_RE.test(values[column])) fail(`Row ${sourceRow} has invalid hierarchy UUID.`);
    }
    return { sourceRow, legacyId: values[0], email: emailKey(values[8]), values };
  }).filter(Boolean);
  if (rows.length !== ROW_COUNT) fail(`Workbook must contain exactly ${ROW_COUNT} populated rows; found ${rows.length}.`);
  for (const [key, label] of [['legacyId', 'YM Web Site Member ID'], ['email', 'normalized Email']]) {
    const seen = new Map();
    for (const row of rows) {
      if (seen.has(row[key])) fail(`Duplicate ${label} at rows ${seen.get(row[key])} and ${row.sourceRow}.`);
      seen.set(row[key], row.sourceRow);
    }
  }
  const counts = {
    group: rows.filter((row) => row.values[11]).length,
    organization: rows.filter((row) => row.values[12]).length,
  };
  if (counts.group !== ASSIGNMENT_COUNTS.group || counts.organization !== ASSIGNMENT_COUNTS.organization) {
    fail(`Hierarchy source counts drifted: ${JSON.stringify(counts)}.`);
  }
  return { fingerprint, rows, counts };
}
export const readSource = (file = FILE) => parseSourceBytes(readFileSync(file));

export function auditMappings(fields, source) {
  return CUSTOM_MAPPINGS.map((contract) => {
    const candidates = fields.filter((field) => field.entity_scope === 'member'
      && (field.id === contract.id || field.name === contract.name || field.label === contract.label));
    if (candidates.length !== 1) fail(`Expected one unambiguous live field for "${contract.label}"; found ${candidates.length}.`);
    const field = candidates[0];
    if (field.id !== contract.id || field.tenant_id !== TENANT_ID || field.name !== contract.name
      || field.label !== contract.label || field.field_type !== contract.type || field.is_active !== true) {
      fail(`Live field contract drifted for "${contract.label}".`);
    }
    const requested = [...new Set(source.rows.map((row) => row.values[contract.column]).filter(Boolean))];
    if (contract.type === 'dropdown') {
      const allowed = new Set((field.options || [])
        .flatMap((option) => [clean(option?.value), clean(option?.label)]).filter(Boolean));
      const unsupported = requested.filter((value) => !allowed.has(value));
      if (unsupported.length) fail(`Unsupported "${contract.label}" value(s): ${unsupported.join(', ')}.`);
    } else if (field.options != null) fail(`Field "${contract.label}" unexpectedly has controlled options.`);
    return { ...contract, requested };
  });
}

export function auditHierarchy(source, state) {
  const groups = new Map();
  for (const group of state.groups || []) {
    if (groups.has(group.id)) fail(`Duplicate destination Group id "${group.id}".`);
    groups.set(group.id, group);
  }
  const organizations = new Map();
  for (const organization of state.organizations || []) {
    if (organizations.has(organization.id)) fail(`Duplicate destination Organisation id "${organization.id}".`);
    organizations.set(organization.id, organization);
  }
  for (const row of source.rows) {
    if (row.values[11] && groups.get(row.values[11])?.tenant_id !== TENANT_ID) {
      fail(`Row ${row.sourceRow}: Group is missing or outside BNMS.`);
    }
    if (row.values[12] && organizations.get(row.values[12])?.tenant_id !== TENANT_ID) {
      fail(`Row ${row.sourceRow}: Organisation is missing or outside BNMS.`);
    }
  }
  return { memberDefinition: { id: 'unused' } };
}

async function fetchAll(db, table, columns, configure = (query) => query) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    let result;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        result = await configure(db.from(table).select(columns).order('id').range(from, from + 499));
        if (!result.error) break;
        if (attempt === 4) check(result.error, `Could not read ${table}`);
      } catch (error) {
        if (attempt === 4) fail(`Could not read ${table}: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
    const { data } = result;
    rows.push(...(data || []));
    if ((data || []).length < 500) return rows;
  }
}
async function fetchForIds(db, table, columns, column, ids) {
  const rows = [];
  for (let index = 0; index < ids.length; index += 25) {
    rows.push(...await fetchAll(db, table, columns, (query) => query.in(column, ids.slice(index, index + 25))));
  }
  return rows;
}

export async function loadState(db, source) {
  const legacyFieldId = CUSTOM_MAPPINGS[0].id;
  const legacyIds = source.rows.map((row) => row.legacyId);
  const priorLegacyIds = PRIOR_GUEST_EMAIL_OVERLAPS.map((item) => item.priorLegacyId);
  const [tenantResult, fields, groups, organizations, allMembers, allIdentityValues, nullability] = await Promise.all([
    db.from('tenant').select('id,name').eq('id', TENANT_ID).maybeSingle(),
    fetchAll(db, 'preference_field', 'id,tenant_id,name,label,field_type,entity_scope,is_active,options',
      (query) => query.eq('tenant_id', TENANT_ID).eq('entity_scope', 'member')),
    fetchAll(db, 'organization_group', 'id,tenant_id,name', (query) => query.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'organization', 'id,tenant_id,name', (query) => query.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'member', 'id,tenant_id,email,first_name,last_name,created_on,mobile,organization_id,organization_group_id',
      (query) => query.eq('tenant_id', TENANT_ID)),
    fetchForIds(db, 'member_preference_value', 'id,member_id,field_id,value', 'value',
      [...legacyIds, ...priorLegacyIds]).then((rows) =>
      rows.filter((row) => row.field_id === legacyFieldId)),
    memberAssignmentNullability(),
  ]);
  check(tenantResult.error, 'Could not resolve pinned BNMS tenant');
  if (tenantResult.data?.id !== TENANT_ID || !/\bbnms\b|british nuclear medicine society/i.test(tenantResult.data?.name || '')) {
    fail('Pinned destination is not BNMS.');
  }
  const incomingLegacySet = new Set(legacyIds);
  const priorLegacySet = new Set(priorLegacyIds);
  const legacyValues = allIdentityValues.filter((value) => incomingLegacySet.has(clean(value.value)));
  const priorLegacyValues = allIdentityValues.filter((value) => priorLegacySet.has(clean(value.value)));
  const emails = new Set(source.rows.map((row) => row.email));
  const legacyMemberIds = new Set(allIdentityValues.map((value) => value.member_id));
  const members = allMembers.filter((member) => emails.has(emailKey(member.email)) || legacyMemberIds.has(member.id));
  const memberIds = members.map((member) => member.id);
  const [preferenceValues, memberEdges] = memberIds.length ? await Promise.all([
    fetchForIds(db, 'member_preference_value', 'id,member_id,field_id,value', 'member_id', memberIds),
    fetchForIds(db, 'custom_object_relationship',
      'id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at,archived_by',
      'target_record_id', memberIds),
  ]) : [[], []];
  return {
    tenant: tenantResult.data, fields, groups, organizations, members, preferenceValues,
    memberEdges, legacyValues, priorLegacyValues, nullability,
  };
}

export function auditPriorGuestOverlaps(source, state) {
  const membersByEmail = new Map((state.members || []).map((member) => [emailKey(member.email), member]));
  const incomingByValue = new Map((state.legacyValues || []).map((value) => [clean(value.value), value]));
  const priorByValue = new Map((state.priorLegacyValues || []).map((value) => [clean(value.value), value]));
  for (const contract of PRIOR_GUEST_EMAIL_OVERLAPS) {
    const row = source.rows.find((candidate) => candidate.email === contract.email);
    const member = membersByEmail.get(contract.email);
    if (!row || row.legacyId !== contract.incomingLegacyId || !member) {
      fail(`Prior guest overlap contract drifted for "${contract.email}".`);
    }
    const identity = incomingByValue.get(contract.incomingLegacyId) || priorByValue.get(contract.priorLegacyId);
    if (!identity || identity.member_id !== member.id) {
      fail(`Prior guest overlap identity does not belong to "${contract.email}".`);
    }
  }
}

export function makePlan(source, state, mappings) {
  const byEmail = new Map();
  for (const member of state.members || []) {
    const key = emailKey(member.email);
    if (byEmail.has(key)) fail(`Ambiguous destination Member email "${key}".`);
    if (member.tenant_id !== TENANT_ID) fail(`Member email "${key}" resolved outside BNMS.`);
    byEmail.set(key, member);
  }
  const byLegacy = new Map();
  for (const value of state.legacyValues || []) {
    const key = clean(value.value);
    if (byLegacy.has(key)) fail(`Ambiguous destination legacy ID "${key}".`);
    const member = (state.members || []).find((item) => item.id === value.member_id);
    if (!member) fail(`Legacy ID "${key}" resolved to a missing or out-of-scope Member.`);
    byLegacy.set(key, member);
  }
  const prefs = new Map();
  for (const value of state.preferenceValues || []) {
    const key = `${value.member_id}|${value.field_id}`;
    if (prefs.has(key)) fail(`Duplicate destination preference value for "${key}".`);
    prefs.set(key, value);
  }
  return { items: source.rows.map((row) => {
    const emailMember = byEmail.get(row.email) || null;
    const legacyMember = byLegacy.get(row.legacyId) || null;
    if (emailMember && legacyMember && emailMember.id !== legacyMember.id) {
      fail(`Row ${row.sourceRow}: normalized email and legacy ID match different BNMS Members.`);
    }
    const member = emailMember || legacyMember;
    const patch = {};
    for (const mapping of CORE_MAPPINGS) {
      const raw = row.values[mapping.column];
      if (!raw) continue;
      const desired = xform(raw, mapping.transform, `${mapping.destination} at row ${row.sourceRow}`);
      const current = clean(member?.[mapping.destination]);
      const matches = mapping.transform === 'date'
        ? current.slice(0, 10) === desired
        : member && current === clean(desired);
      if (!matches) patch[mapping.destination] = desired;
    }
    const groupId = row.values[11] || null;
    const organizationId = row.values[12] || null;
    if (groupId) {
      if (!member || member.organization_group_id !== groupId) patch.organization_group_id = groupId;
      if (member?.organization_id != null) patch.organization_id = null;
    } else {
      if (!member || member.organization_id !== organizationId) patch.organization_id = organizationId;
      if (member?.organization_group_id != null) patch.organization_group_id = null;
    }
    const preferences = mappings.flatMap((mapping) => {
      const raw = row.values[mapping.column];
      if (!raw) return [];
      const desired = String(xform(raw, mapping.transform, `${mapping.label} at row ${row.sourceRow}`));
      const existing = member ? prefs.get(`${member.id}|${mapping.id}`) : null;
      return [{ mapping, desired, existing, action: !existing ? 'insert' : clean(existing.value) === clean(desired) ? 'unchanged' : 'update' }];
    });
    const activeDepartmentEdges = member ? (state.memberEdges || []).filter((edge) =>
      edge.target_record_id === member.id && edge.archived_at == null) : [];
    if (activeDepartmentEdges.some((edge) => edge.tenant_id !== TENANT_ID)) {
      fail(`Member "${row.email}" has an active hierarchy edge outside BNMS.`);
    }
    return {
      row, member, patch,
      action: member ? (Object.keys(patch).length ? 'update' : 'unchanged') : 'insert',
      preferences, departmentId: null, departmentIds: [], departmentAssignmentMode: 'preserve',
      edgeAction: 'none', conflictingEdges: [], exactEdges: [], activeDepartmentEdges,
    };
  }) };
}

export const pendingItems = (plan) => plan.items.filter((item) =>
  item.action !== 'unchanged' || item.preferences.some((preference) => preference.action !== 'unchanged'));

function report(source, state, mappings, plan) {
  console.log(`Workbook SHA-256 / rows / columns: ${source.fingerprint} / ${source.rows.length} / ${COLUMN_COUNT}`);
  console.log(`Live BNMS custom fields audited: ${mappings.length}`);
  console.log(`Matched by email or legacy ID: ${plan.items.filter((item) => item.member).length}`);
  console.log(`Members insert/update/unchanged: ${['insert', 'update', 'unchanged'].map((action) => plan.items.filter((item) => item.action === action).length).join('/')}`);
  console.log(`Preference writes: ${plan.items.flatMap((item) => item.preferences).filter((item) => item.action !== 'unchanged').length}`);
  console.log(`Existing legacy-ID matches: ${state.legacyValues.length}`);
  const overlaps = PRIOR_GUEST_EMAIL_OVERLAPS.map((contract) =>
    `${contract.email} (${contract.priorLegacyId} -> ${contract.incomingLegacyId})`);
  console.log(`Prior guest email overlaps reconciled: ${overlaps.join(', ')}`);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (args.some((arg) => arg !== '--apply')) fail('Only --apply is supported; no --apply performs a dry run.');
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required.');
  }
  console.log(`\n=== BNMS guest Member import (${apply ? 'APPLY' : 'DRY RUN — NO WRITES'}) ===`);
  const source = readSource();
  const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
  const state = await loadState(db, source);
  const mappings = auditMappings(state.fields, source);
  const hierarchy = auditHierarchy(source, state);
  auditPriorGuestOverlaps(source, state);
  const plan = makePlan(source, state, mappings);
  const inserts = plan.items.filter((item) => !item.member);
  if (inserts.length && (!state.nullability?.organization_id || !state.nullability?.organization_group_id)) {
    fail('Unlinked Guest Members cannot be inserted because Member hierarchy fields were not confirmed nullable.');
  }
  report(source, state, mappings, plan);
  if (!apply) return console.log('DRY RUN complete: no writes.');
  const initial = {
    insert: plan.items.filter((item) => item.action === 'insert').length,
    update: plan.items.filter((item) => item.action === 'update').length,
    unchanged: plan.items.filter((item) => item.action === 'unchanged').length,
  };
  const result = await applyPlan(db, plan, hierarchy);
  await verifyOrCompensate(result.journal, async () => {
    const verified = await loadState(db, source);
    const replayMappings = auditMappings(verified.fields, source);
    auditHierarchy(source, verified);
    auditPriorGuestOverlaps(source, verified);
    const replay = makePlan(source, verified, replayMappings);
    const pending = pendingItems(replay);
    if (replay.items.some((item) => !item.member) || verified.legacyValues.length !== ROW_COUNT || pending.length) {
      fail(`Post-import verification failed: ${replay.items.filter((item) => item.member).length} Members, ${verified.legacyValues.length} legacy IDs, ${pending.length} pending rows.`);
    }
  });
  console.log(`Applied: ${initial.insert} created, ${initial.update} updated, ${initial.unchanged} unchanged; ${result.preferenceWrites} preference writes. Replay: zero writes.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exit(1); });
}
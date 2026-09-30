#!/usr/bin/env node
/**
 * Dry-run-first updater for the pinned 54-row BNMS Radiopharmacy CSV.
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
export const FILE = path.join(ROOT, 'attached_assets', 'Radiopharmacy_contacts_updated_31.08.26_1788196158731.csv');
export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const SHARON_MEMBER_ID = '3d291826-13d8-4fc1-9221-7627fc45830a';
export const HEADERS = ['id', 'YM Web Site Member ID', 'YM Membership type', 'Member class', 'Membership status'];
export const ROW_COUNT = 54;
export const EXPECTED_FILE_SHA256 = 'fd124219db3e595f87a49175f000503d6e7baecad6b8e3fb00808c5c045db3df';
export const FIELD_CONTRACTS = [
  { source: 'YM Web Site Member ID', id: '50d7b71c-29b0-4d4c-a817-f39edf35f2e0', name: 'ym_web_site_member_id', label: 'YM Web Site Member ID', type: 'text' },
  { source: 'YM Membership type', id: '40bdb74f-e8e0-4ad1-9760-b1128256a752', name: 'ym_membership_type', label: 'YM Membership type', type: 'dropdown' },
  { source: 'Member class', id: '87f120ff-92e6-4d52-944b-9ba9d7b1fac0', name: 'member_class', label: 'Member class', type: 'dropdown' },
  { source: 'Membership status', id: '388e1dfe-d917-4317-933a-0319542a7d92', name: 'membership_status', label: 'Membership status', type: 'dropdown' },
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function fail(message) { throw new Error(message); }
function check(error, context) { if (error) fail(`${context}: ${error.message}`); }
function clean(value) { return String(value ?? '').normalize('NFKC').trim(); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }

export function readSource(file = FILE) {
  const bytes = readFileSync(file);
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (fingerprint !== EXPECTED_FILE_SHA256) fail(`CSV fingerprint mismatch; expected ${EXPECTED_FILE_SHA256}, found ${fingerprint}.`);
  const workbook = XLSX.read(bytes, { type: 'buffer', raw: false });
  if (workbook.SheetNames.length !== 1) fail(`CSV must parse as exactly one sheet; found ${workbook.SheetNames.length}.`);
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: null, raw: false });
  const headers = (grid[0] || []).map(clean);
  if (headers.length !== HEADERS.length || headers.some((value, i) => value !== HEADERS[i])) {
    fail(`CSV headers must be exactly: ${HEADERS.join(' | ')}. Found: ${headers.join(' | ') || '(none)'}.`);
  }
  const rows = grid.slice(1).filter((row) => row.some((value) => clean(value))).map((row, index) => {
    const values = HEADERS.map((_, column) => clean(row[column]));
    const missing = HEADERS.filter((_, column) => !values[column]);
    if (missing.length) fail(`CSV row ${index + 2} is missing: ${missing.join(', ')}.`);
    if (!UUID_RE.test(values[0])) fail(`CSV row ${index + 2} has invalid Member id "${values[0]}".`);
    return { sourceRow: index + 2, id: values[0].toLowerCase(), values: Object.fromEntries(HEADERS.slice(1).map((header, i) => [header, values[i + 1]])) };
  });
  if (rows.length !== ROW_COUNT) fail(`CSV must contain ${ROW_COUNT} populated rows; found ${rows.length}.`);
  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row.id)) fail(`Duplicate Member id at rows ${seen.get(row.id)} and ${row.sourceRow}.`);
    seen.set(row.id, row.sourceRow);
  }
  const expectedConstants = {
    'YM Membership type': ['Radiopharmacy Departmental Contact'],
    'Member class': ['Department contact'],
    'Membership status': ['Active'],
  };
  for (const [column, expected] of Object.entries(expectedConstants)) {
    const actual = [...new Set(rows.map((row) => row.values[column]))].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${column} values drifted: ${actual.join(', ')}.`);
  }
  return { rows, fingerprint };
}

export function auditMappings(fields, source) {
  return FIELD_CONTRACTS.map((contract) => {
    const candidates = fields.filter((field) => field.id === contract.id
      || field.name === contract.name || field.label === contract.label);
    if (candidates.length !== 1) fail(`Expected one unambiguous live field for "${contract.source}"; found ${candidates.length}.`);
    const field = candidates[0];
    if (field.id !== contract.id || field.tenant_id !== TENANT_ID || field.entity_scope !== 'member'
      || field.name !== contract.name || field.label !== contract.label || field.field_type !== contract.type || field.is_active !== true) {
      fail(`Live field contract drifted for "${contract.source}".`);
    }
    const requested = [...new Set(source.rows.map((row) => row.values[contract.source]))];
    if (contract.type === 'dropdown') {
      const allowed = new Set((field.options || []).flatMap((option) => [clean(option?.value), clean(option?.label)]));
      const unsupported = requested.filter((value) => !allowed.has(value));
      if (unsupported.length) fail(`Unsupported "${contract.source}" value(s): ${unsupported.join(', ')}.`);
    } else if (field.options != null) {
      fail(`Text field "${contract.source}" unexpectedly has controlled options.`);
    }
    return { ...contract, requested };
  });
}

export function makePlan(source, members, values, mappings) {
  const memberGroups = new Map();
  for (const member of members) memberGroups.set(member.id, [...(memberGroups.get(member.id) || []), member]);
  const missing = source.rows.filter((row) => !memberGroups.has(row.id)).map((row) => row.id);
  const duplicate = source.rows.filter((row) => (memberGroups.get(row.id) || []).length > 1).map((row) => row.id);
  const crossTenant = source.rows.filter((row) => (memberGroups.get(row.id) || []).some((member) => member.tenant_id !== TENANT_ID)).map((row) => row.id);
  if (missing.length || duplicate.length || crossTenant.length) {
    fail(`Member resolution failed: missing=${missing.length}, duplicate=${duplicate.length}, crossTenant=${crossTenant.length}.`);
  }
  const valueGroups = new Map();
  for (const value of values) {
    const key = `${value.member_id}|${value.field_id}`;
    valueGroups.set(key, [...(valueGroups.get(key) || []), value]);
  }
  const items = [];
  for (const row of source.rows) {
    for (const mapping of mappings) {
      const key = `${row.id}|${mapping.id}`;
      const existing = valueGroups.get(key) || [];
      if (existing.length > 1) fail(`Duplicate preference values for Member ${row.id}, field ${mapping.label}.`);
      const desired = row.values[mapping.source];
      items.push({ memberId: row.id, fieldId: mapping.id, source: mapping.source, desired, existing: existing[0] || null, action: existing[0]?.value === desired ? 'unchanged' : existing.length ? 'update' : 'insert' });
    }
  }
  // This maintenance import owns preference values only. Department
  // assignments are an unmanaged set and are always preserved.
  return { items, departmentAssignmentMode: 'preserve', departmentIds: null };
}

function destinationClient() {
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required.');
  return createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
}

async function fetchPaged(buildQuery, context) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await buildQuery(from, from + 499);
    check(error, context);
    rows.push(...(data || []));
    if ((data || []).length < 500) return rows;
  }
}

async function fetchState(db, source) {
  const ids = source.rows.map((row) => row.id);
  const fieldIds = FIELD_CONTRACTS.map((field) => field.id);
  const [tenantResult, fieldsResult, membersResult, valuesResult] = await Promise.all([
    db.from('tenant').select('id,name').eq('id', TENANT_ID).maybeSingle(),
    db.from('preference_field').select('id,tenant_id,name,label,field_type,entity_scope,is_active,options').eq('tenant_id', TENANT_ID),
    db.from('member').select('*').in('id', ids),
    db.from('member_preference_value').select('id,member_id,field_id,value').in('member_id', ids).in('field_id', fieldIds),
  ]);
  check(tenantResult.error, 'Could not resolve BNMS tenant');
  check(fieldsResult.error, 'Could not read BNMS preference fields');
  check(membersResult.error, 'Could not resolve source Members');
  check(valuesResult.error, 'Could not read source Member preference values');
  if (tenantResult.data?.id !== TENANT_ID || tenantResult.data?.name !== 'BNMS') fail('Pinned destination is not the exact BNMS tenant.');
  return { tenant: tenantResult.data, fields: fieldsResult.data || [], members: membersResult.data || [], values: valuesResult.data || [] };
}

async function preservationSnapshot(db, source) {
  const ids = source.rows.map((row) => row.id);
  const fieldIds = FIELD_CONTRACTS.map((field) => field.id);
  const [members, unrelatedSourcePrefs, targetPrefsOutsideSource, memberCount] = await Promise.all([
    db.from('member').select('*').in('id', ids).order('id'),
    fetchPaged(
      (from, to) => db.from('member_preference_value').select('*').in('member_id', ids)
        .not('field_id', 'in', `(${fieldIds.join(',')})`).order('id').range(from, to),
      'Could not snapshot unrelated source preferences',
    ),
    fetchPaged(
      (from, to) => db.from('member_preference_value').select('*').in('field_id', fieldIds)
        .not('member_id', 'in', `(${ids.join(',')})`).order('id').range(from, to),
      'Could not snapshot out-of-source target preferences',
    ),
    db.from('member').select('id', { count: 'exact', head: true }).eq('tenant_id', TENANT_ID),
  ]);
  for (const [label, result] of Object.entries({ members, memberCount })) check(result.error, `Could not snapshot ${label}`);
  // Preference-value writes touch member.updated_at through a database trigger.
  // Compare every substantive Member column while excluding that managed audit timestamp.
  const protectedMembers = (members.data || []).map(({ updated_at: _managedTimestamp, ...member }) => member);
  return digest({ members: protectedMembers, unrelatedSourcePrefs, targetPrefsOutsideSource, memberCount: memberCount.count });
}

export function validateAppliedRows(data, writes) {
  if ((data || []).length !== writes.length) fail(`Preference-value upsert returned ${(data || []).length}/${writes.length} rows.`);
  const expected = new Map(writes.map((row) => [`${row.member_id}|${row.field_id}`, row.value]));
  if (data.some((row) => expected.get(`${row.member_id}|${row.field_id}`) !== row.value)) fail('Preference-value upsert returned unexpected rows.');
}

async function applyPlan(db, plan) {
  const writes = plan.items.filter((item) => item.action !== 'unchanged').map((item) => ({
    member_id: item.memberId, field_id: item.fieldId, value: item.desired,
  }));
  if (!writes.length) return 0;
  const { data, error } = await db.from('member_preference_value').upsert(writes, { onConflict: 'member_id,field_id' }).select('member_id,field_id,value');
  check(error, 'Atomic preference-value upsert failed');
  validateAppliedRows(data, writes);
  return writes.length;
}

function report(source, state, mappings, plan) {
  console.log('\n--- Validated source and destination ---');
  console.log(`  CSV SHA-256:                      ${source.fingerprint}`);
  console.log(`  Exact populated rows / IDs:       ${source.rows.length}/${new Set(source.rows.map((row) => row.id)).size}`);
  console.log(`  Tenant:                           ${state.tenant.name} (${TENANT_ID})`);
  console.log(`  Exact BNMS Member matches:        ${state.members.length}/${ROW_COUNT}`);
  console.log('\n--- Approved mapping and changes ---');
  for (const mapping of mappings) {
    const items = plan.items.filter((item) => item.fieldId === mapping.id);
    console.log(`  ${mapping.source} -> member preference "${mapping.label}" (${mapping.id}, ${mapping.type})`);
    console.log(`    values: ${mapping.requested.join(', ')}; insert/update/unchanged: ${items.filter((x) => x.action === 'insert').length}/${items.filter((x) => x.action === 'update').length}/${items.filter((x) => x.action === 'unchanged').length}`);
  }
  const exceptions = plan.items.filter((item) => !['insert', 'update', 'unchanged'].includes(item.action));
  console.log(`  Row-level exceptions:             ${exceptions.length}`);
  console.log(`  Total writes:                     ${plan.items.filter((item) => item.action !== 'unchanged').length}`);
  console.log('  Department assignment set:        preserved (unmanaged)');
  console.log('  Member rows/relationships/roles:  read-only');
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some((argument) => argument !== '--apply')) fail('Only --apply is supported; no flag performs a dry run.');
  console.log(`\n=== BNMS Radiopharmacy Member field update (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  const source = readSource();
  const db = destinationClient();
  const state = await fetchState(db, source);
  const mappings = auditMappings(state.fields, source);
  const plan = makePlan(source, state.members, state.values, mappings);
  report(source, state, mappings, plan);
  if (!apply) return console.log('\n=== DRY RUN complete: no database rows modified ===\n');
  const before = await preservationSnapshot(db, source);
  const writes = await applyPlan(db, plan);
  const verified = await fetchState(db, source);
  const replayMappings = auditMappings(verified.fields, source);
  const replay = makePlan(source, verified.members, verified.values, replayMappings);
  if (replay.items.some((item) => item.action !== 'unchanged')) fail('Post-import verification failed: replay still proposes writes.');
  if (before !== await preservationSnapshot(db, source)) fail('An unrelated Member field, preference value, Member count, or out-of-scope target value changed.');
  console.log(`\nApplied and verified ${writes} preference values across ${ROW_COUNT} Members.`);
  console.log('Second dry run: 0 writes. Unrelated data snapshot: unchanged.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`\nERROR: ${error.message}`); process.exit(1); });
}
#!/usr/bin/env node
/**
 * Dry-run-first setter for the pinned BNMS survey respondent CSV.
 *
 * Usage:
 *   node scripts/set-bnms-survey-respondents.mjs
 *   node scripts/set-bnms-survey-respondents.mjs --apply
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import { coerceBooleanPreferenceValue } from '../api/_lib/booleanCoercion.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'attached_assets', 'Individual_survey_respondants_1788548366967.csv');
export const EXPECTED_FILE_SHA256 = '63abc3e2a678f751d0331bb25dbcf6fbeeb61810b39db2a4a9a88ec763d643ed';
export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const ROW_COUNT = 53;
export const HEADERS = ['id', 'Survey respondant'];
export const FIELD_NAME = 'survey_respondent';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function fail(message) { throw new Error(message); }
function check(error, context) { if (error) fail(`${context}: ${error.message}`); }
function clean(value) { return String(value ?? '').normalize('NFKC').trim(); }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function readSource(file = FILE) {
  const bytes = readFileSync(file);
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (fingerprint !== EXPECTED_FILE_SHA256) {
    fail(`CSV fingerprint mismatch; expected ${EXPECTED_FILE_SHA256}, found ${fingerprint}.`);
  }
  const workbook = XLSX.read(bytes, { type: 'buffer', raw: false });
  if (workbook.SheetNames.length !== 1) fail(`CSV must parse as exactly one sheet; found ${workbook.SheetNames.length}.`);
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: null, raw: false });
  const headers = (grid[0] || []).map(clean);
  if (headers.length !== HEADERS.length || headers.some((header, index) => header !== HEADERS[index])) {
    fail(`CSV headers must be exactly: ${HEADERS.join(' | ')}. Found: ${headers.join(' | ') || '(none)'}.`);
  }
  const rows = grid.slice(1).filter((row) => row.some((value) => clean(value))).map((row, index) => {
    const id = clean(row[0]).toLowerCase();
    if (!UUID_RE.test(id)) fail(`CSV row ${index + 2} has invalid Member id "${id}".`);
    const desired = coerceBooleanPreferenceValue(clean(row[1]));
    if (desired !== 'true') fail(`CSV row ${index + 2} must request true; found "${clean(row[1])}".`);
    if (row.length > HEADERS.length && row.slice(HEADERS.length).some((value) => clean(value))) {
      fail(`CSV row ${index + 2} contains unexpected extra values.`);
    }
    return { sourceRow: index + 2, id, desired };
  });
  if (rows.length !== ROW_COUNT) fail(`CSV must contain ${ROW_COUNT} populated rows; found ${rows.length}.`);
  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row.id)) fail(`Duplicate Member id at rows ${seen.get(row.id)} and ${row.sourceRow}.`);
    seen.set(row.id, row.sourceRow);
  }
  return { rows, fingerprint };
}

export function auditField(fields) {
  const matches = fields.filter((field) => field.name === FIELD_NAME);
  if (matches.length !== 1) fail(`Expected exactly one active BNMS field named "${FIELD_NAME}"; found ${matches.length}.`);
  const field = matches[0];
  if (field.tenant_id !== TENANT_ID || field.entity_scope !== 'member'
    || !['boolean', 'checkbox'].includes(field.field_type) || field.is_active !== true) {
    fail(`BNMS "${FIELD_NAME}" field is not an active member-scoped boolean field.`);
  }
  return field;
}

export function makePlan(source, members, values, field) {
  const memberGroups = new Map();
  for (const member of members) memberGroups.set(member.id, [...(memberGroups.get(member.id) || []), member]);
  const missing = source.rows.filter((row) => !memberGroups.has(row.id));
  const rejected = source.rows.filter((row) => (memberGroups.get(row.id) || []).length !== 1
    || memberGroups.get(row.id)[0].tenant_id !== TENANT_ID);
  if (missing.length || rejected.length) {
    fail(`Member validation failed: missing=${missing.length}, rejected=${rejected.length}.`);
  }
  const valueGroups = new Map();
  for (const value of values) valueGroups.set(value.member_id, [...(valueGroups.get(value.member_id) || []), value]);
  const items = source.rows.map((row) => {
    const existing = valueGroups.get(row.id) || [];
    if (existing.length > 1) fail(`Duplicate "${FIELD_NAME}" values exist for Member ${row.id}.`);
    const action = !existing.length ? 'insert' : existing[0].value === 'true' ? 'unchanged' : 'update';
    return { memberId: row.id, fieldId: field.id, desired: 'true', existing: existing[0] || null, action };
  });
  return {
    items,
    inserted: items.filter((item) => item.action === 'insert').length,
    updated: items.filter((item) => item.action === 'update').length,
    unchanged: items.filter((item) => item.action === 'unchanged').length,
    missing: 0,
    rejected: 0,
  };
}

function destinationClient() {
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required; SOURCE and bare SUPABASE credentials are forbidden.');
  }
  return createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
}

async function fetchState(db, source) {
  const ids = source.rows.map((row) => row.id);
  const [tenantResult, fieldsResult, membersResult] = await Promise.all([
    db.from('tenant').select('id,name').eq('id', TENANT_ID).maybeSingle(),
    db.from('preference_field').select('id,tenant_id,name,label,field_type,entity_scope,is_active')
      .eq('tenant_id', TENANT_ID).eq('name', FIELD_NAME).eq('is_active', true),
    db.from('member').select('id,tenant_id').in('id', ids),
  ]);
  check(tenantResult.error, 'Could not resolve pinned BNMS tenant');
  check(fieldsResult.error, 'Could not resolve survey respondent field');
  check(membersResult.error, 'Could not resolve source Members');
  if (tenantResult.data?.id !== TENANT_ID || !/\bbnms\b|british nuclear medicine society/i.test(tenantResult.data?.name || '')) {
    fail(`Pinned tenant is not British Nuclear Medicine Society (${tenantResult.data?.name || 'not found'}).`);
  }
  const field = auditField(fieldsResult.data || []);
  const { data: values, error: valuesError } = await db.from('member_preference_value')
    .select('id,member_id,field_id,value').eq('field_id', field.id).in('member_id', ids);
  check(valuesError, 'Could not read survey respondent values');
  return { tenant: tenantResult.data, field, members: membersResult.data || [], values: values || [] };
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

async function preservationSnapshot(db, source, field) {
  const ids = source.rows.map((row) => row.id);
  const [members, unrelatedPrefs, outsideTarget] = await Promise.all([
    db.from('member').select('*').in('id', ids).order('id'),
    fetchPaged(
      (from, to) => db.from('member_preference_value').select('*').in('member_id', ids)
        .neq('field_id', field.id).order('id').range(from, to),
      'Could not snapshot unrelated preferences',
    ),
    fetchPaged(
      (from, to) => db.from('member_preference_value').select('*').eq('field_id', field.id)
        .not('member_id', 'in', `(${ids.join(',')})`).order('id').range(from, to),
      'Could not snapshot out-of-scope target values',
    ),
  ]);
  check(members.error, 'Could not snapshot Members');
  const protectedMembers = (members.data || []).map(({ updated_at: _managedTimestamp, ...member }) => member);
  return digest({ members: protectedMembers, unrelatedPrefs, outsideTarget });
}

function report(title, source, state, plan) {
  console.log(`\n--- ${title} ---`);
  console.log(`  CSV SHA-256:          ${source.fingerprint}`);
  console.log(`  Unique Member IDs:    ${source.rows.length}/${ROW_COUNT}`);
  console.log(`  Tenant:               ${state.tenant.name} (${state.tenant.id})`);
  console.log(`  Field:                ${state.field.name} (${state.field.id}, ${state.field.field_type})`);
  console.log(`  Inserted:             ${plan.inserted}`);
  console.log(`  Updated:              ${plan.updated}`);
  console.log(`  Unchanged:            ${plan.unchanged}`);
  console.log(`  Missing:              ${plan.missing}`);
  console.log(`  Rejected:             ${plan.rejected}`);
}

async function applyPlan(db, plan) {
  const writes = plan.items.filter((item) => item.action !== 'unchanged')
    .map((item) => ({ member_id: item.memberId, field_id: item.fieldId, value: item.desired }));
  if (!writes.length) return 0;
  const { data, error } = await db.from('member_preference_value')
    .upsert(writes, { onConflict: 'member_id,field_id' }).select('member_id,field_id,value');
  check(error, 'Atomic survey respondent upsert failed');
  if ((data || []).length !== writes.length || data.some((row) => row.value !== 'true')) {
    fail(`Upsert returned an unexpected result (${(data || []).length}/${writes.length} canonical rows).`);
  }
  return writes.length;
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some((argument) => argument !== '--apply')) fail('Only --apply is supported; no flag performs a dry run.');
  console.log(`\n=== Set BNMS survey respondents (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  const source = readSource();
  const db = destinationClient();
  const state = await fetchState(db, source);
  const plan = makePlan(source, state.members, state.values, state.field);
  report('Pre-change report', source, state, plan);
  if (!apply) return console.log('\n=== DRY RUN complete: no database rows modified ===\n');
  const before = await preservationSnapshot(db, source, state.field);
  const writes = await applyPlan(db, plan);
  const verified = await fetchState(db, source);
  const replay = makePlan(source, verified.members, verified.values, verified.field);
  if (replay.unchanged !== ROW_COUNT || replay.inserted || replay.updated) fail('Post-change verification still proposes writes.');
  if (before !== await preservationSnapshot(db, source, verified.field)) fail('Out-of-scope Member or preference data changed.');
  report('Post-change verification', source, verified, {
    inserted: plan.inserted, updated: plan.updated, unchanged: plan.unchanged, missing: 0, rejected: 0,
  });
  console.log(`\nApplied ${writes} writes; verified ${ROW_COUNT}/${ROW_COUNT} canonical true values.`);
  console.log('Idempotent replay: 0 writes. Out-of-scope snapshot: unchanged.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`\nERROR: ${error.message}`); process.exit(1); });
}
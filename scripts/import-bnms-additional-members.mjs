#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { TENANT_ID, clean, emailKey, parseBritishDate, applyPlan, verifyOrCompensate } from './import-bnms-direct-debit-members.mjs';
import { CUSTOM_MAPPINGS as UK_FIELDS, FOCUS_AREA } from './import-bnms-uk-individual-members.mjs';

export const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../attached_assets/Additional_individuals_to_import_into_iConnect_18.09.26_1789834165856.xlsx');
export const EXPECTED_FILE_SHA256 = '4eb58bf46387b55456888cb4250d9651825450d2f33063d8999427c2599c7555';
export const HEADERS = ['YM Web Site Member ID', 'Membership status', 'YM Date Membership Expires', 'YM Membership type', 'Member class', 'First Name', 'Last Name', 'Title', 'Email', 'Alternative email address', 'Phone', 'Employer_Name', 'Employer_City', 'Group UUID', 'Organisation UUID', 'Employer_Address_Line1', 'Employer_Address_Line2', 'Employer_Location', 'Employer_Postal_Code', 'Employer_Country', 'Occupation', 'SRP/IRPA Affiliate', 'Qualifications', 'BNMS Region', 'Student Status', 'Student Course', 'Student End Date', 'Trainee training scheme name', 'Trainee training number', 'Trainee research fellow information', 'Category - Focus Area'];
export const BLOCKED_COLUMNS = [11, 12, 15, 16, 17, 18, 19, 22, 24];
const remap = { 0: 0, 2: 1, 3: 2, 4: 3, 5: 4, 8: 7, 10: 9, 21: 23, 22: 20, 23: 21, 25: 27, 26: 28, 27: 29 };
export const CUSTOM_MAPPINGS = [
  ...UK_FIELDS.filter(m => Object.hasOwn(remap, m.column)).map(m => ({ ...m, column: remap[m.column] })),
  { id: 'a55e6c86-1b33-494a-adfd-0ac6717a18da', column: 25, name: 'student_course_title', label: 'Student course title', type: 'text' },
  { id: '462a3258-0808-4edc-bd01-45c7def87af2', column: 26, name: 'student_course_end_date', label: 'Student course end date', type: 'date', transform: 'student-date' },
];
const fail = message => { throw new Error(message); };
const check = (error, label) => { if (error) fail(`${label}: ${error.message}`); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function dateValue(value, serial = false) {
  const text = clean(value);
  if (serial && /^\d+$/.test(text)) {
    const number = Number(text);
    if (number < 61 || number > 100000) fail('Invalid Excel date serial');
    return new Date(Date.UTC(1899, 11, 30) + number * 86400000).toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [y, m, d] = text.split('-');
    return parseBritishDate(`${d}/${m}/${y}`);
  }
  return parseBritishDate(text);
}
export function valueFor(mapping, value) {
  if (mapping.transform === 'validated-date') { dateValue(value); return value; }
  if (mapping.transform === 'student-date') return dateValue(value, true);
  if (mapping.transform === 'boolean') {
    if (!['Yes', 'No'].includes(value)) fail('Expected Yes or No');
    return value === 'Yes' ? 'true' : 'false';
  }
  return mapping.transform === 'email' ? emailKey(value) : value;
}
export function parseSourceBytes(bytes, { verifyFingerprint = true } = {}) {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (verifyFingerprint && fingerprint !== EXPECTED_FILE_SHA256) fail('Workbook fingerprint mismatch');
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false });
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== 'Sheet1') fail('Expected only Sheet1');
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets.Sheet1, { header: 1, raw: false, defval: '', blankrows: true });
  if (grid[0]?.length !== HEADERS.length || HEADERS.some((h, i) => grid[0][i] !== h)) fail('Workbook header contract drifted');
  const rows = grid.slice(1).map((original, i) => {
    const values = Array.from({ length: HEADERS.length }, (_, c) => clean(original[c]));
    if (!values.some(Boolean)) return null;
    const reasons = BLOCKED_COLUMNS.filter(c => values[c]).map(c => `Unmapped ${HEADERS[c]}${c === 24 ? ': legacy reference is not an uploaded attachment' : ''}`);
    if (original.length > HEADERS.length) fail('Unexpected source columns');
    for (const c of [0, 5, 6, 8]) if (!values[c]) reasons.push(`Missing ${HEADERS[c]}`);
    for (const c of [8, 9]) if (values[c] && !email.test(values[c])) reasons.push(`Invalid ${HEADERS[c]}`);
    if (values[10] && !/^\+?[\d ()-]{5,30}$/.test(values[10])) reasons.push('Unsafe Phone');
    if (values[13] && values[14]) reasons.push('Multiple hierarchy destinations');
    for (const c of [13, 14]) if (values[c] && !uuid.test(values[c])) reasons.push(`Invalid ${HEADERS[c]}`);
    for (const mapping of CUSTOM_MAPPINGS) {
      if (!values[mapping.column]) continue;
      try { valueFor(mapping, values[mapping.column]); } catch { reasons.push(`Invalid ${HEADERS[mapping.column]}`); }
    }
    return { sourceRow: i + 2, original: Array.from({ length: HEADERS.length }, (_, c) => String(original[c] ?? '')), values, email: emailKey(values[8]), legacyId: values[0], reasons };
  }).filter(Boolean);
  if (rows.length !== 96) fail('Expected 96 populated rows');
  for (const key of ['email', 'legacyId']) {
    for (const row of rows) if (rows.filter(r => r[key] === row[key]).length !== 1) row.reasons.push(`Duplicate source ${key}`);
  }
  const counts = [13, 14].map(c => rows.filter(r => r.values[c]).length);
  if (counts[0] !== 36 || counts[1] !== 38 || rows.filter(r => !r.values[13] && !r.values[14]).length !== 22) fail('Hierarchy counts drifted');
  return { fingerprint, rows };
}
export async function fetchAll(db, table, columns = '*', configure = q => q) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await configure(db.from(table).select(columns).order('id').range(from, from + 499));
    check(error, `Read ${table}`); rows.push(...data);
    if (data.length < 500) return rows;
  }
}
export async function loadState(db) {
  const scope = q => q.eq('tenant_id', TENANT_ID);
  const [tenant, fields, members, legacy, groups, organizations, categories] = await Promise.all([
    db.from('tenant').select('id,name').eq('id', TENANT_ID).single(),
    fetchAll(db, 'preference_field', '*', scope), fetchAll(db, 'member', '*', scope),
    fetchAll(db, 'member_preference_value', '*', q => q.eq('field_id', CUSTOM_MAPPINGS[0].id)),
    fetchAll(db, 'organization_group', '*', scope), fetchAll(db, 'organization', '*', scope),
    fetchAll(db, 'resource_category', '*', scope),
  ]);
  check(tenant.error, 'Tenant');
  if (tenant.data?.id !== TENANT_ID || tenant.data.name !== 'BNMS') fail('Destination tenant mismatch');
  const preferences = [], memberCategories = [], edges = [];
  for (let i = 0; i < members.length; i += 100) {
    const ids = members.slice(i, i + 100).map(m => m.id);
    const [p, c, e] = await Promise.all([
      fetchAll(db, 'member_preference_value', '*', q => q.in('member_id', ids)),
      fetchAll(db, 'member_resource_category', '*', q => q.in('member_id', ids)),
      fetchAll(db, 'custom_object_relationship', '*', q => q.in('target_record_id', ids)),
    ]);
    preferences.push(...p); memberCategories.push(...c); edges.push(...e);
  }
  return { fields, members, legacy, groups, organizations, categories, preferences, memberCategories, edges };
}
export function makePlan(source, state, nullable = false) {
  const items = [], held = [];
  const focus = state.categories.filter(c => c.id === FOCUS_AREA.id || c.name === FOCUS_AREA.name);
  for (const row of source.rows) {
    const reasons = [...row.reasons];
    const emailMatches = state.members.filter(m => emailKey(m.email) === row.email);
    const legacyMatches = state.legacy.filter(p => clean(p.value) === row.legacyId);
    const legacyMembers = legacyMatches.map(p => state.members.find(m => m.id === p.member_id));
    if (emailMatches.length > 1 || legacyMatches.length > 1 || legacyMembers.some(m => !m)) reasons.push('Ambiguous or out-of-tenant destination identity');
    const matches = [...new Map([...emailMatches, ...legacyMembers.filter(Boolean)].map(m => [m.id, m])).values()];
    if (matches.length > 1) reasons.push('Email and legacy ID match different members');
    const member = matches[0] || null;
    if (member && member.tenant_id !== TENANT_ID) reasons.push('Member outside BNMS');
    const patch = {}, preferences = [], focusAreas = [];
    const desire = (key, value) => {
      if (!value) return;
      const current = clean(member?.[key]);
      if (current && current !== value && !(key === 'email' && emailKey(current) === value)) reasons.push(`Conflicting nonblank ${key}`);
      else if (current !== value) patch[key] = value;
    };
    desire('first_name', row.values[5]); desire('last_name', row.values[6]); desire('email', row.email); desire('mobile', row.values[10]);
    for (const [column, table, destination, other] of [[13, 'groups', 'organization_group_id', 'organization_id'], [14, 'organizations', 'organization_id', 'organization_group_id']]) {
      if (!row.values[column]) continue;
      const target = state[table].find(x => x.id === row.values[column]);
      if (!target || target.tenant_id !== TENANT_ID) reasons.push(`Missing or foreign ${HEADERS[column]}`);
      if (column === 14 && target?.organization_group_id && !state.groups.some(g => g.id === target.organization_group_id && g.tenant_id === TENANT_ID)) reasons.push('Organisation parent outside BNMS');
      if (member?.[other]) reasons.push('Conflicting existing hierarchy');
      desire(destination, row.values[column]);
    }
    if (!member && !nullable) reasons.push('Nullable hierarchy columns not confirmed');
    for (const mapping of CUSTOM_MAPPINGS) {
      const raw = row.values[mapping.column]; if (!raw) continue;
      const fields = state.fields.filter(f => f.entity_scope === 'member' && (f.id === mapping.id || f.name === mapping.name || f.label === mapping.label));
      const field = fields[0];
      if (fields.length !== 1 || field.id !== mapping.id || field.name !== mapping.name || field.label !== mapping.label || field.field_type !== mapping.type || field.tenant_id !== TENANT_ID || !field.is_active) { reasons.push(`Unavailable field ${mapping.label}`); continue; }
      if (mapping.type === 'dropdown' && !(field.options || []).some(o => o.value === raw || o.label === raw)) reasons.push(`Unsupported ${mapping.label}`);
      let desired;
      try { desired = valueFor(mapping, raw); } catch { continue; }
      const existing = member ? state.preferences.filter(p => p.member_id === member.id && p.field_id === mapping.id) : [];
      if (existing.length > 1) reasons.push(`Duplicate ${mapping.label}`);
      if (existing[0] && clean(existing[0].value) && clean(existing[0].value) !== desired) reasons.push(`Conflicting nonblank ${mapping.label}`);
      preferences.push({ mapping, desired, existing: existing[0], action: !existing.length ? 'insert' : clean(existing[0].value) === desired ? 'unchanged' : 'update' });
    }
    for (const name of [...new Set(row.values[30].split('|').map(clean).filter(Boolean))]) {
      if (focus.length !== 1 || focus[0].id !== FOCUS_AREA.id || focus[0].tenant_id !== TENANT_ID || !focus[0].is_active || !focus[0].subcategories?.includes(name)) reasons.push('Unsupported Focus Area');
      const existing = member ? state.memberCategories.filter(c => c.member_id === member.id && c.resource_category_id === FOCUS_AREA.id && c.subcategory_name === name) : [];
      if (existing.length > 1) reasons.push('Duplicate Focus Area');
      focusAreas.push({ name, action: existing.length ? 'unchanged' : 'insert' });
    }
    if (member && Object.keys(patch).some(k => k.startsWith('organization')) && state.edges.some(e => e.target_record_id === member.id && e.archived_at == null)) reasons.push('Hierarchy change could affect existing relationships');
    if (reasons.length) held.push({ ...row, reasons: [...new Set(reasons)], memberIds: matches.map(m => m.id) });
    else items.push({ row, member, patch, preferences, focusAreas, action: !member ? 'insert' : Object.keys(patch).length ? 'update' : 'unchanged', edgeAction: 'none', departmentIds: [], conflictingEdges: [], exactEdges: [], activeDepartmentEdges: [] });
  }
  // Two distinct source identities must never update the same destination.
  const conflicts = items.filter(i => i.member && (items.filter(j => j.member?.id === i.member.id).length > 1 || held.some(h => h.memberIds.includes(i.member.id))));
  for (const item of conflicts) held.push({ ...item.row, reasons: ['Destination also matched by another or held source row'], memberIds: [item.member.id] });
  return { items: items.filter(i => !conflicts.includes(i)), held };
}
export const pendingItems = plan => plan.items.filter(i => i.action !== 'unchanged' || i.preferences.some(p => p.action !== 'unchanged') || i.focusAreas.some(c => c.action !== 'unchanged'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function preservationSnapshot(state, plan) {
  const managed = new Map(plan.items.filter(i => i.member).map(i => [i.member.id, i]));
  const members = state.members.map(m => { const result = { ...m }; for (const k of Object.keys(managed.get(m.id)?.patch || {})) delete result[k]; delete result.updated_at; return result; });
  const preferences = state.preferences.filter(p => !managed.get(p.member_id)?.preferences.some(v => v.mapping.id === p.field_id && v.action !== 'unchanged'));
  const cats = state.memberCategories.filter(c => !managed.get(c.member_id)?.focusAreas.some(f => f.name === c.subcategory_name && c.resource_category_id === FOCUS_AREA.id && f.action === 'insert'));
  return digest([members, preferences, cats, state.edges].map(rows => rows.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))));
}
export async function applyAdditionalPlan(db, plan) {
  const result = await applyPlan(db, plan, { memberDefinition: { id: 'unused' } });
  try {
    const members = await fetchAll(db, 'member', 'id,email', q => q.eq('tenant_id', TENANT_ID));
    for (const item of plan.items) {
      const member = members.find(m => emailKey(m.email) === item.row.email);
      if (!member) fail('Imported member missing');
      for (const area of item.focusAreas.filter(a => a.action === 'insert')) {
        const { data, error } = await db.from('member_resource_category').insert({ member_id: member.id, resource_category_id: FOCUS_AREA.id, subcategory_name: area.name }).select('*').single();
        check(error, 'Focus Area write');
        if (!data?.id) fail('Focus Area insert returned no ID');
        result.journal.push({ label: 'Remove inserted Focus Area', rollback: async () => {
          const deleted = await db.from('member_resource_category').delete().eq('id', data.id).select('id');
          check(deleted.error, 'Focus Area rollback'); if (deleted.data.length !== 1) fail('Incomplete category rollback');
        } });
        if (data.member_id !== member.id || data.resource_category_id !== FOCUS_AREA.id || data.subcategory_name !== area.name) fail('Focus Area readback mismatch');
      }
    }
    return result;
  } catch (error) { await verifyOrCompensate(result.journal, async () => { throw error; }); throw error; }
}
export function heldCsv(held) {
  const cell = value => `"${String(value).replace(/^[\s]*[=+@\-\t\r]/, match => `'${match}`).replaceAll('"', '""')}"`;
  return '\uFEFF' + [['Source row', 'Hold reasons', ...HEADERS], ...held.map(r => [r.sourceRow, r.reasons.join('; '), ...r.original])].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
export async function main(args = process.argv.slice(2)) {
  let reportDir = path.resolve('exports/bnms-additional-members');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') continue;
    if (args[i] === '--report-dir' && args[i + 1] && !args[i + 1].startsWith('--')) { reportDir = path.resolve(args[++i]); continue; }
    fail('Usage: [--apply] [--report-dir /tmp/private-directory]');
  }
  if (!reportDir.startsWith('/tmp/')) {
    try { execFileSync('git', ['check-ignore', '-q', `${reportDir}/held-rows.csv`]); } catch { fail('Report directory must be git-ignored or under /tmp/'); }
  }
  if (process.env.DEST_SUPABASE_URL !== 'https://lvmzliemqnieeoruhkik.supabase.co' || !process.env.DEST_SUPABASE_KEY) fail('Pinned DEST credentials required');
  const source = parseSourceBytes(readFileSync(FILE));
  const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
  const response = await fetch(`${process.env.DEST_SUPABASE_URL}/rest/v1/`, { headers: { apikey: process.env.DEST_SUPABASE_KEY, Authorization: `Bearer ${process.env.DEST_SUPABASE_KEY}`, Accept: 'application/openapi+json' } });
  if (!response.ok) fail('Cannot confirm hierarchy nullability');
  const schema = await response.json(); const member = schema.definitions?.member || schema.components?.schemas?.member;
  const nullable = ['organization_id', 'organization_group_id'].every(k => member?.properties?.[k] && !member.required?.includes(k));
  const state = await loadState(db), plan = makePlan(source, state, nullable);
  mkdirSync(reportDir, { recursive: true, mode: 0o700 }); chmodSync(reportDir, 0o700);
  const save = (name, value) => { const file = path.join(reportDir, name); writeFileSync(file, value, { mode: 0o600 }); chmodSync(file, 0o600); };
  save('held-rows.csv', heldCsv(plan.held));
  save('plan.json', JSON.stringify({ fingerprint: source.fingerprint, eligibleRows: plan.items.map(i => i.row.sourceRow), held: plan.held.map(h => ({ sourceRow: h.sourceRow, reasons: h.reasons })) }, null, 2));
  console.log(JSON.stringify({ source: source.rows.length, eligible: plan.items.length, held: plan.held.length, pending: pendingItems(plan).length, insert: plan.items.filter(i => !i.member).length, reportDir }));
  if (!args.includes('--apply')) return;
  const before = preservationSnapshot(state, plan);
  const result = await applyAdditionalPlan(db, plan);
  await verifyOrCompensate(result.journal, async () => {
    const after = await loadState(db);
    const originalIds = new Set(state.members.map(m => m.id));
    const filtered = { ...after, members: after.members.filter(m => originalIds.has(m.id)), preferences: after.preferences.filter(p => originalIds.has(p.member_id)), memberCategories: after.memberCategories.filter(c => originalIds.has(c.member_id)), edges: after.edges.filter(e => originalIds.has(e.target_record_id)) };
    if (before !== preservationSnapshot(filtered, plan)) fail('Preservation verification failed');
    const replay = makePlan({ ...source, rows: plan.items.map(i => i.row) }, after, nullable);
    if (replay.held.length || replay.items.length !== plan.items.length || replay.items.some(i => !i.member) || pendingItems(replay).length) fail('Zero-write replay failed');
  });
  save('result.json', JSON.stringify({ imported: plan.items.length, held: plan.held.length, replayPending: 0, preservationVerified: true }));
  console.log('Import verified: zero pending writes; pre-existing unmanaged data preserved.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
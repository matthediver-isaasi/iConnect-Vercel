#!/usr/bin/env node
// Operational DEST-only import. Private workbook and evidence are never committed.
// Dry-run first, then --apply --approved-hash=<printed plan hash>.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import xlsx from 'xlsx';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

export const TENANT = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
export const ROLE = '18533de9-32d1-427a-8be9-d37954ad416c';
const INPUT = 'attached_assets/AHECS_Members_for_GFI_Import_02.10.26_1790935316849.xlsx';
const INPUT_HASH = 'db23252a5e62963fa575087c1a27aa85023f71fc93e681ae77a0d6a27fc4bcc1';
const DIR = 'private/gfi-ahecs-members';
const PLAN = `${DIR}/plan.json`;
const assert = (ok, code) => { if (!ok) throw new Error(code); };
export const hash = value => createHash('sha256').update(
  Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const save = (name, value) => writeFileSync(`${DIR}/${name}.json`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const q = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const norm = value => String(value ?? '').trim().toLowerCase();
export function validateRows(raw) {
  assert(raw.length === 17, 'EXPECTED_17_ROWS');
  const emails = new Set();
  const rows = raw.map((r, i) => {
    assert(Object.keys(r).join(',') === 'first_name,last_name,email,organisation_id,organisation_name', 'INVALID_HEADERS');
    assert(Object.values(r).every(v => typeof v === 'string' && v.trim() && !/[\x00-\x1f]/.test(v)), 'INVALID_CELL');
    const email = norm(r.email);
    assert(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 'INVALID_EMAIL');
    assert(!emails.has(email), 'DUPLICATE_EMAIL');
    emails.add(email);
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.organisation_id), 'INVALID_ORGANIZATION_ID');
    const h = hash([PROJECT, TENANT, INPUT_HASH, email]);
    return { row: i + 2, id: `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`,
      first_name: r.first_name.trim(), last_name: r.last_name.trim(), email,
      organization_id: r.organisation_id, organization_name: r.organisation_name.trim() };
  });
  assert(new Set(rows.map(r => r.organization_id)).size === 11, 'EXPECTED_11_ORGANIZATIONS');
  return rows;
}
function loadInput() {
  const bytes = readFileSync(INPUT);
  assert(hash(bytes) === INPUT_HASH, 'INPUT_BYTES_CHANGED');
  const workbook = xlsx.read(bytes);
  assert(workbook.Sheets.Import, 'IMPORT_SHEET_MISSING');
  return validateRows(xlsx.utils.sheet_to_json(workbook.Sheets.Import, { defval: '' }));
}
export function classify(rows, members, organizations) {
  return rows.map(r => {
    const org = organizations.find(o => o.id === r.organization_id);
    const matches = members.filter(m => norm(m.email) === r.email);
    const reason = !org || org.tenant_id !== TENANT ? 'invalid-organization'
      : org.name.trim() !== r.organization_name ? 'organization-label-mismatch'
        : matches.length > 1 ? 'ambiguous-email' : null;
    return { ...r, action: reason ? 'blocked' : matches.length ? 'already-present' : 'create',
      reason, existingId: matches.length === 1 ? matches[0].id : null };
  });
}
export function matchesRequested(r, m) {
  return m?.id === r.id && m.tenant_id === TENANT && m.email === r.email &&
    m.first_name === r.first_name && m.last_name === r.last_name &&
    m.organization_id === r.organization_id && m.role_id === ROLE &&
    m.login_enabled === true && m.show_in_directory === false &&
    m.is_guest === false && m.status === 'active' && m.organization_group_id === null;
}
const TABLES = ['member', 'organization', 'role', 'tenant', 'member_group', 'workflow', 'system_settings'];
async function guard(c) {
  const columns = await q(c, `select table_name,column_name,column_default,data_type,is_nullable
    from information_schema.columns where table_schema='public' and table_name=any($1) order by 1,2`, [TABLES]);
  const triggers = await q(c, `select t.tgfoid,t.tgenabled,pg_get_triggerdef(t.oid) definition
    from pg_trigger t where t.tgrelid in ('public.member'::regclass,'public.member_group'::regclass)
    order by t.oid`);
  const all = await q(c, `select oid,proname,pg_get_functiondef(oid) definition from pg_proc
    where pronamespace='public'::regnamespace and prokind in ('f','p') order by oid`);
  const wanted = new Set(triggers.map(t => t.tgfoid));
  for (let previous = -1; previous !== wanted.size;) {
    previous = wanted.size;
    const body = all.filter(f => wanted.has(f.oid)).map(f => f.definition).join('\n');
    for (const f of all) if (new RegExp(`\\b${f.proname}\\s*\\(`, 'i').test(body)) wanted.add(f.oid);
  }
  const functions = all.filter(f => wanted.has(f.oid));
  const rules = await q(c, `select * from pg_rules where schemaname='public' and tablename=any($1) order by tablename,rulename`, [TABLES]);
  assert(rules.length === 0, 'UNREVIEWED_RULES');
  const constraints = await q(c, `select conname,pg_get_constraintdef(oid) definition from pg_constraint
    where conrelid='public.member'::regclass order by conname`);
  const indexes = await q(c, `select indexname,indexdef from pg_indexes where schemaname='public' and tablename='member' order by indexname`);
  return { columns, triggers, functions, rules, constraints, indexes };
}
async function configuration(c, rows) {
  const tenant = await q(c, 'select id,name from public.tenant where id=$1', [TENANT]);
  assert(tenant.length === 1 && tenant[0].name === 'Graduate Futures Institute', 'TENANT_PIN_FAILED');
  const roles = await q(c, "select * from public.role where tenant_id=$1 and lower(trim(name))='ahecs' order by id", [TENANT]);
  assert(roles.length === 1 && roles[0].id === ROLE && roles[0].is_admin === false &&
    roles[0].is_tenant_admin === false && roles[0].max_members === null, 'ROLE_PIN_FAILED');
  const organizations = await q(c, 'select id,name,tenant_id from public.organization where id=any($1::uuid[]) order by id', [rows.map(r => r.organization_id)]);
  const groups = await q(c, 'select * from public.member_group where tenant_id=$1 order by id', [TENANT]);
  assert(groups.every(g => !g.automatic_membership_enabled), 'AUTOMATIC_GROUP_SIDE_EFFECT');
  const workflows = await q(c, 'select * from public.workflow where tenant_id=$1 and is_active order by id', [TENANT]);
  assert(workflows.every(w => w.trigger_type === 'field_change'), 'UNREVIEWED_WORKFLOW');
  const gate = await q(c, "select * from public.system_settings where tenant_id=$1 and setting_key='organization_login_gate'", [TENANT]);
  assert(gate.length === 0, 'UNREVIEWED_LOGIN_GATE');
  return { tenant, roles, organizations, groups, workflows, gate };
}
const members = c => q(c, `select to_jsonb(m) data from public.member m where tenant_id=$1 order by id`, [TENANT]).then(rs => rs.map(r => r.data));
async function evidence(c) {
  const result = {};
  for (const table of ['member_communication_preference', 'workflow_log', 'workflow_delivery_claim',
    'form_due_diligence_field_mapping_workflow_outbox', 'member_login_session_revocation', 'member_group']) {
    result[table] = (await q(c, `select count(*)::int count,
      md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) fingerprint
      from public.${table} t where tenant_id=$1`, [TENANT]))[0];
  }
  return result;
}
export async function main(args = process.argv.slice(2)) {
  const apply = args.includes('--apply');
  const approvedHash = args.find(a => a.startsWith('--approved-hash='))?.split('=')[1];
  assert(args.every(a => ['--apply', '--dry-run'].includes(a) || /^--approved-hash=[a-f0-9]{64}$/.test(a)), 'UNKNOWN_ARGUMENT');
  assert(!(apply && args.includes('--dry-run')), 'CONFLICTING_MODES');
  assert(!apply || approvedHash, 'APPROVAL_REQUIRED');
  const rows = loadInput();
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const runnerHash = hash(readFileSync(new URL(import.meta.url)));
  const plan = apply ? JSON.parse(readFileSync(PLAN, 'utf8')) : null;
  if (apply) assert(hash(plan) === approvedHash && plan.runnerHash === runnerHash &&
    plan.inputHash === INPUT_HASH && plan.project === PROJECT && plan.tenant === TENANT, 'PLAN_PIN_FAILED');
  const c = await connectDestination();
  let commitAttempted = false, committed = false;
  try {
    await c.query(apply ? 'begin' : 'begin isolation level repeatable read read only');
    await c.query("set local statement_timeout='15s'; set local lock_timeout='5s'; set local idle_in_transaction_session_timeout='30s'; set local search_path=public,pg_catalog");
    if (apply) {
      // Predicate protection for normalized-email existence; no triggers disabled.
      await c.query('lock table public.member,public.member_group in share row exclusive mode');
      await c.query(`lock table public.organization,public.role,public.tenant,public.workflow,public.system_settings,
        public.member_communication_preference,public.workflow_log,public.workflow_delivery_claim,
        public.form_due_diligence_field_mapping_workflow_outbox,public.member_login_session_revocation in share mode`);
    }
    const schema = await guard(c), config = await configuration(c, rows);
    const before = await members(c), beforeEvidence = await evidence(c);
    const decisions = classify(rows, before, config.organizations);
    if (!apply) {
      const next = { project: PROJECT, tenant: TENANT, inputHash: INPUT_HASH, runnerHash,
        schemaHash: hash(schema), configHash: hash(config), decisions };
      save('plan', next); save('reviewed-schema', schema);
      await c.query('rollback');
      console.log(JSON.stringify({ mode: 'dry-run', approvedHash: hash(next),
        counts: count(decisions), functions: schema.functions.map(f => f.proname) }));
      return;
    }
    assert(hash(schema) === plan.schemaHash && hash(config) === plan.configHash, 'REVIEWED_GUARD_CHANGED');
    const creates = plan.decisions.filter(r => r.action === 'create');
    const replay = creates.length > 0 && creates.every(r => matchesRequested(r, before.find(m => m.id === r.id)));
    if (!replay) assert(hash(decisions) === hash(plan.decisions), 'MATCH_PLAN_CHANGED');
    let created = 0;
    if (!replay) for (const r of creates) {
      const result = await c.query(`insert into public.member
        (id,tenant_id,email,first_name,last_name,organization_id,role_id,login_enabled,show_in_directory,is_guest,status,organization_group_id)
        values($1,$2,$3,$4,$5,$6,$7,true,false,false,'active',null)`,
      [r.id, TENANT, r.email, r.first_name, r.last_name, r.organization_id, ROLE]);
      assert(result.rowCount === 1, 'INSERT_COUNT_FAILED'); created++;
    }
    const after = await members(c), afterEvidence = await evidence(c);
    assert(creates.every(r => matchesRequested(r, after.find(m => m.id === r.id)) &&
      after.filter(m => norm(m.email) === r.email).length === 1), 'COHORT_VERIFICATION_FAILED');
    const newIds = new Set(replay ? [] : creates.map(r => r.id));
    assert(hash(before) === hash(after.filter(m => !newIds.has(m.id))), 'EXISTING_MEMBER_CHANGED');
    assert(after.length === before.length + created && hash(beforeEvidence) === hash(afterEvidence), 'SIDE_EFFECT_DETECTED');
    assert(hash(await guard(c)) === plan.schemaHash && hash(await configuration(c, rows)) === plan.configHash, 'GUARD_CHANGED_DURING_IMPORT');
    if (created) { commitAttempted = true; await c.query('commit'); committed = true; }
    else await c.query('rollback');
    // Independent post-transaction read verifies durable cohort, not only uncommitted rows.
    await c.query('begin isolation level repeatable read read only');
    const persisted = await members(c);
    assert(creates.every(r => matchesRequested(r, persisted.find(m => m.id === r.id)) &&
      persisted.filter(m => norm(m.email) === r.email).length === 1), 'POST_COMMIT_VERIFICATION_FAILED');
    await c.query('rollback');
    const result = { mode: replay ? 'zero-write-replay' : 'applied', project: PROJECT, tenant: TENANT,
      inputHash: INPUT_HASH, created, alreadyPresent: plan.decisions.filter(r => r.action === 'already-present').length,
      blocked: plan.decisions.filter(r => r.action === 'blocked').length, failed: 0, verified: creates.length,
      writes: created, beforeEvidence, afterEvidence, verifiedAt: new Date().toISOString(),
      unrelatedPostCommitMemberCountDelta: persisted.length - after.length, migrations: 'none' };
    save(replay ? 'replay-result' : 'apply-result', result);
    save('row-reconciliation', plan.decisions.map(r => ({ ...r,
      result: r.action === 'create' ? 'verified-imported' : r.action,
      verified: r.action === 'create' ? matchesRequested(r, persisted.find(m => m.id === r.id)) : null })));
    console.log(JSON.stringify(result));
  } catch (error) {
    await c.query('rollback').catch(() => {});
    console.error(JSON.stringify({ status: committed ? 'COMMITTED_REQUIRES_VERIFICATION' :
      commitAttempted ? 'COMMIT_UNKNOWN_RECHECK' : 'NOT_COMMITTED',
    error: /^[A-Z_]+$/.test(error.message) ? error.message : error.code || 'IMPORT_FAILED' }));
    process.exitCode = 1;
  } finally { await c.end(); }
}
function count(rows) {
  return Object.fromEntries(['create', 'already-present', 'blocked'].map(k => [k, rows.filter(r => r.action === k).length]));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(JSON.stringify({ status: 'NOT_STARTED', error: /^[A-Z_]+$/.test(error.message) ? error.message : 'PREFLIGHT_FAILED' }));
  process.exitCode = 1;
});
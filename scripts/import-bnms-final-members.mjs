#!/usr/bin/env node
// Dedicated insert-only cohort. No historical importer or validator apply path is reused.
// Read-only: node scripts/import-bnms-final-members.mjs --allow-existing-regional-rules
// Apply additionally requires --apply --review-sha256=<printed hash>.
// The regional flag records the user's separate approval of existing regional
// queue/reconciliation effects, including rechecking prior assignments; it never
// authorizes unknown rule shapes, new permissions, notifications or financial work.
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, chmodSync, openSync, closeSync, writeSync, fsyncSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE, TENANT_ID, CUSTOM_MAPPINGS, parseSourceBytes } from './bnms-final-source.mjs';
import { loadState, makeReport } from './validate-bnms-final-members.mjs';

export const PROJECT = 'lvmzliemqnieeoruhkik';
export const DIRECTORY = path.resolve('exports/bnms-final-import');
export const APPROVED_ROWS = Object.freeze(Array.from({ length: 79 }, (_, i) => i + 2).filter(r =>
  ![2, 75, 76, 77, 79, 80].includes(r) && !(r >= 40 && r <= 65)));
const FOCUS = '9e6a7200-1194-4e75-98d1-25a29303e95e';
const TABLES = ['tenant', 'member', 'member_preference_value', 'member_resource_category', 'preference_field', 'resource_category', 'organization', 'organization_group', 'organization_preference_value', 'custom_object_relationship', 'custom_object_relationship_definition', 'member_group', 'member_group_assignment', 'member_group_activity', 'member_group_history_group', 'member_group_membership_history'];
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const assert = (value, message) => { if (!value) throw Error(message); };
// Read-only reviewed live snapshot, including transitive helper bodies and the
// history/activity tables reached by approved regional-rule reconciliation.
const AUDITED_SCHEMA_HASH = '5f4dbbc4e10d2adf8e3789d7954f9443f85ff80ec6099e3ff5f15a282f3256c7';

export function sideEffectAudit(schema) {
  const schemaHash = digest(schema);
  assert(schemaHash === AUDITED_SCHEMA_HASH, 'Live side-effect/default audit drifted; review code and schema before any import');
  return {
    schemaHash, triggerHash: digest(schema.triggers), helperHash: digest(schema.functions),
    memberDefaultsHash: digest(schema.columns.filter(c => c.table_name === 'member')),
    conclusions: [
      'Member INSERT triggers perform tenant/role guards, advisory locks and automatic group queueing only; role guard exits for NULL role/disabled login.',
      'Preference INSERT triggers validate scope, queue affected rules, and bump only the newly inserted parent updated_at; parent UPDATE queues no changes for updated_at alone.',
      'Regional queue updates generation/status/cursor and group identity history; reconciliation changes group assignments, group activity and membership history, including existing assignments as authorized.',
      'Group assignment triggers only acquire advisory locks and record group history. Group history/activity tables have no user triggers.',
      'No reachable SQL helper performs HTTP, email, account/identity creation, access grants, billing, consent recording or purchased membership-term creation.',
      'Explicit overrides: login_enabled=false, role_id/identity_id/google_id/created_on=NULL, show_in_directory=false. Remaining member defaults are literal metadata/empty collections or updated_at=now(); status active is metadata, not login permission.',
      'Default communications_opted_out_all=false records no affirmative consent; no consent or subscription rows are created.',
      'Application reconciliation source calls only filter/read/reconciliation/status APIs (plus existing operational heartbeat); no member notification or payment path is invoked by this runner.',
    ],
    applicationSourceHashes: Object.fromEntries(['api/cron/process-automatic-memberships.js', 'api/_lib/automaticMembership.js', 'api/_lib/automaticMembershipQuery.js'].map(file =>
      [file, createHash('sha256').update(readFileSync(file)).digest('hex')])),
    limitation: 'SQL evidence is live and pinned; local application source review does not attest deployment identity. Independent scheduled/provider jobs are not invoked or disabled by this importer.',
  };
}

// Deliberately narrower than the application evaluator: only the reviewed regional
// equality rules can be proved here. Unknown forms are not interpreted as false.
export function automaticBoundary(source, groups, preferences) {
  const memberField = '0e3e3b1f-5a3d-40b5-a4b5-f0761c115216';
  const orgField = '91e58f93-f78f-465e-948b-c4808aecd89c';
  assert(!CUSTOM_MAPPINGS.some(m => m.id === memberField), 'Region member field unexpectedly mapped');
  const rules = groups.map(group => {
    assert(group.automatic_membership_role === 'Member', 'Unknown automatic group role');
    const filters = group.automatic_membership_filter_groups;
    assert(Array.isArray(filters) && filters.length === 2, 'Unknown automatic filter groups');
    const conditions = filters.map(filter => {
      assert(Object.keys(filter).length === 1 && Array.isArray(filter.conditions) && filter.conditions.length === 1, 'Unknown automatic conjunction');
      const condition = filter.conditions[0];
      assert(Object.keys(condition).sort().join(',') === 'data_type,entity_scope,field_key,field_type,operator,value'
        && condition.operator === 'equals' && condition.field_type === 'custom' && condition.data_type === 'select'
        && typeof condition.value === 'string' && condition.value.length > 0
        && ((condition.entity_scope === 'member' && condition.field_key === memberField)
          || (condition.entity_scope === 'organization' && condition.field_key === orgField)), 'Unknown automatic condition');
      return condition;
    });
    assert(new Set(conditions.map(c => c.entity_scope)).size === 2 && conditions[0].value === conditions[1].value, 'Unknown automatic regional rule');
    return { groupId: group.id, value: conditions[0].value };
  });
  const heldRows = [];
  const evidence = source.rows.filter(r => APPROVED_ROWS.includes(r.sourceRow)).map(row => {
    const matches = preferences.filter(p => p.organization_id === row.values[12] && p.field_id === orgField);
    assert(matches.length <= 1, 'Ambiguous organization region');
    // Same exact string equality as automaticMembership.js; absence is empty.
    const value = String(matches[0]?.value ?? '');
    const matchedGroups = rules.filter(rule => value === rule.value).map(rule => rule.groupId);
    if (matchedGroups.length) heldRows.push(row.sourceRow);
    return { sourceRow: row.sourceRow, region: value, matchedGroups };
  });
  return { heldRows, rules, evidence };
}

export function savePrivate(name, value) {
  assert(/^[a-z-]+\.json$/.test(name), 'Invalid evidence filename');
  execFileSync('git', ['check-ignore', '-q', `${DIRECTORY}/${name}`]);
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 }); chmodSync(DIRECTORY, 0o700);
  const target = path.join(DIRECTORY, name), temporary = `${target}.${randomUUID()}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, target);
  const directoryFd = openSync(DIRECTORY, 'r');
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

export async function schemaEvidence(client) {
  const columns = (await client.query(`select table_name,column_name,data_type,is_nullable,column_default
    from information_schema.columns where table_schema='public' and table_name=any($1) order by table_name,ordinal_position`, [TABLES])).rows;
  const triggers = (await client.query(`select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition,pg_get_functiondef(t.tgfoid) function
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=any($1) and not t.tgisinternal order by c.relname,t.tgname`, [TABLES])).rows;
  // Include transitive public helper bodies in the reviewed hash, not merely trigger entry points.
  const functions = (await client.query(`select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' order by 1`)).rows;
  return { columns, triggers, functions };
}

export function planRows(report, journal) {
  assert(APPROVED_ROWS.length === 47, 'Cohort cardinality');
  return report.rows.map(row => {
    if (!APPROVED_ROWS.includes(row.sourceRow)) return { sourceRow: row.sourceRow, outcome: row.outcome === 'user-excluded' ? 'excluded' : 'held-original', reasons: row.reasons };
    const owned = journal?.members?.find(m => m.sourceRow === row.sourceRow);
    if (row.outcome === 'ready-new') return { sourceRow: row.sourceRow, outcome: 'insert', memberId: owned?.memberId || randomUUID() };
    if (row.outcome === 'existing-unchanged' && owned && row.memberIds.length === 1 && row.memberIds[0] === owned.memberId) {
      return { sourceRow: row.sourceRow, outcome: 'already-imported', memberId: owned.memberId };
    }
    return { sourceRow: row.sourceRow, outcome: 'held-fresh', reasons: row.reasons.length ? row.reasons : ['Fresh identity is not journal-owned; no existing-member updates authorized'] };
  });
}

export async function verifySafeMembers(client, ids) {
  const rows = (await client.query(`select id,login_enabled,role_id,identity_id,google_id,created_on,show_in_directory
    from public.member where id=any($1::uuid[]) and tenant_id=$2`, [ids, TENANT_ID])).rows;
  assert(rows.length === ids.length && rows.every(m => m.login_enabled === false && m.role_id == null && m.identity_id == null
    && m.google_id == null && m.created_on == null && m.show_in_directory === false), 'Imported access/date safety verification failed');
}

export async function insertRow(client, row, memberId) {
  await client.query(`insert into public.member
    (id,tenant_id,email,first_name,last_name,mobile,organization_group_id,organization_id,login_enabled,role_id,identity_id,google_id,created_on,show_in_directory)
    values($1,$2,$3,$4,$5,$6,$7,$8,false,null,null,null,null,false)`,
  [memberId, TENANT_ID, row.email, row.values[5], row.values[6], row.values[10] || null, row.values[11] || null, row.values[12] || null]);
  for (const mapping of CUSTOM_MAPPINGS) {
    if (!row.values[mapping.column]) continue;
    await client.query('insert into public.member_preference_value(member_id,field_id,value) values($1,$2,$3)', [memberId, mapping.id, row.values[mapping.column]]);
  }
  for (const name of [...new Set(row.values[20].split('|').map(s => s.trim()).filter(Boolean))]) {
    await client.query('insert into public.member_resource_category(member_id,resource_category_id,subcategory_name) values($1,$2,$3)', [memberId, FOCUS, name]);
  }
}

export async function connectDestination() {
  assert(process.env.DEST_SUPABASE_URL === `https://${PROJECT}.supabase.co`, 'Pinned DEST REST URL required');
  const target = new URL(process.env.DEST_DATABASE_URL);
  assert(decodeURIComponent(target.username) === `postgres.${PROJECT}` && /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(target.hostname), 'Pinned DEST SQL target required');
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt', { redirect: 'error' });
  assert(response.ok, 'Trusted TLS CA unavailable');
  const ca = await response.text(); target.searchParams.delete('sslmode');
  const client = new pg.Client({ connectionString: target.toString(), ssl: { ca, rejectUnauthorized: true, servername: target.hostname } });
  await client.connect(); return client;
}

export function applyRegionalPolicy(execution, boundary, allowExistingRegionalRules = false) {
  return execution.map(row => !allowExistingRegionalRules && boundary.heldRows.includes(row.sourceRow)
    ? { ...row, outcome: 'held-fresh', reasons: ['Would match a live automatic member-group rule; unapproved downstream membership assignment'] } : row);
}

export function resultFilename(pendingCount, reusedCount) {
  return pendingCount === 0 && reusedCount > 0 ? 'replay-result.json' : 'result.json';
}

export async function run(client, source, { apply = false, reviewHash, allowExistingRegionalRules = false } = {}) {
  const journalFile = path.join(DIRECTORY, 'journal.json');
  const oldJournal = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : null;
  if (oldJournal) assert(oldJournal.fingerprint === source.fingerprint && oldJournal.tenant === TENANT_ID && oldJournal.project === PROJECT, 'Journal source/target mismatch');
  let committed = false;
  await client.query(apply ? 'BEGIN' : 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    if (apply) {
      // READ COMMITTED plus locks acquired before reads avoids a pre-lock stale snapshot.
      await client.query(`LOCK TABLE ${TABLES.map(t => `public.${t}`).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    }
    const schema = await schemaEvidence(client), schemaHash = digest(schema);
    savePrivate('schema.json', schema);
    const sideEffects = sideEffectAudit(schema);
    if (apply) assert(reviewHash === schemaHash, 'Schema review hash changed or missing');
    const activeGroups = (await client.query('select id,automatic_membership_role,automatic_membership_filter_groups from public.member_group where tenant_id=$1 and automatic_membership_enabled=true order by id', [TENANT_ID])).rows;
    const orgPreferences = (await client.query('select p.* from public.organization_preference_value p join public.organization o on o.id=p.organization_id where o.tenant_id=$1 order by p.id', [TENANT_ID])).rows;
    const boundary = automaticBoundary(source, activeGroups, orgPreferences);
    const before = await loadState(client), report = makeReport(source, before);
    assert(!report.schemaBlockers.length && report.mappings.every(m => m.verified && !m.issues.length), 'Live mapping/schema audit failed');
    const execution = applyRegionalPolicy(planRows(report, oldJournal), boundary, allowExistingRegionalRules);
    const pending = execution.filter(r => r.outcome === 'insert');
    const reused = execution.filter(r => r.outcome === 'already-imported');
    await verifySafeMembers(client, reused.map(r => r.memberId));
    const evidence = { project: PROJECT, tenant: TENANT_ID, fingerprint: source.fingerprint, generatedAt: new Date().toISOString(), schemaHash, preflight: report, execution,
      verification: { committed: false }, counts: {}, automaticBoundary: boundary, sideEffects,
      authorization: { allowExistingRegionalRules, scope: 'Existing supported regional rules, their queues and rechecking existing assignments only. No accounts, login, notifications, billing, consent or membership terms.' },
      safetyBlockers: allowExistingRegionalRules ? [] : ['Automatic queue/reconciliation requires explicit --allow-existing-regional-rules approval'] };
    savePrivate('preflight.json', evidence);
    if (!apply) { await client.query('ROLLBACK'); return evidence; }
    assert(evidence.safetyBlockers.length === 0, evidence.safetyBlockers.join('; '));
    // Durable intent BEFORE any mutation; reuse the same IDs following rollback or an uncertain COMMIT.
    const journal = { project: PROJECT, tenant: TENANT_ID, fingerprint: source.fingerprint, schemaHash, authorization: evidence.authorization, sideEffectAuditHash: digest(sideEffects),
      members: [...(oldJournal?.members || []), ...pending.filter(r => !oldJournal?.members?.some(m => m.sourceRow === r.sourceRow)).map(r => ({ sourceRow: r.sourceRow, memberId: r.memberId }))] };
    savePrivate('journal.json', journal);
    for (const item of pending) await insertRow(client, report.rows.find(r => r.sourceRow === item.sourceRow), item.memberId);
    const after = await loadState(client), replay = makeReport(source, after);
    for (const item of [...pending, ...reused]) {
      const row = replay.rows.find(r => r.sourceRow === item.sourceRow);
      assert(row.outcome === 'existing-unchanged' && row.memberIds.length === 1 && row.memberIds[0] === item.memberId, 'Zero-write replay failed');
    }
    await verifySafeMembers(client, [...pending, ...reused].map(r => r.memberId));
    const insertedIds = new Set(pending.map(r => r.memberId));
    for (const key of ['members', 'preferences', 'legacy', 'memberCategories', 'edges']) {
      const retained = after[key].filter(r => !insertedIds.has(key === 'members' ? r.id : key === 'edges' ? r.target_record_id : r.member_id));
      assert(digest(retained) === digest(before[key]), `Pre-existing ${key} preservation failed`);
    }
    evidence.verification = { committed: false, zeroWriteReplay: true, preExistingPreserved: true, accessDisabled: true };
    savePrivate('verified-before-commit.json', evidence);
    await client.query('COMMIT'); committed = true;
    evidence.execution = execution.map(r => r.outcome === 'insert' ? { ...r, outcome: 'inserted' } : r);
    evidence.verification.committed = true;
    evidence.counts = Object.fromEntries([...new Set(evidence.execution.map(r => r.outcome))].map(k => [k, evidence.execution.filter(r => r.outcome === k).length]));
    savePrivate(resultFilename(pending.length, reused.length), evidence); return evidence;
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  const apply = args.includes('--apply');
  const allowExistingRegionalRules = args.includes('--allow-existing-regional-rules');
  assert(new Set(args).size === args.length && args.every(a => a === '--apply' || a === '--allow-existing-regional-rules' || /^--review-sha256=[a-f0-9]{64}$/.test(a)) && args.length <= 3, 'Usage: [--allow-existing-regional-rules] [--apply --review-sha256=<schema hash>]');
  const reviewHash = args.find(a => a.startsWith('--review-sha256='))?.split('=')[1];
  assert(!apply || reviewHash, 'Apply requires reviewed schema hash');
  const source = parseSourceBytes(readFileSync(FILE));
  const client = await connectDestination();
  try {
    const evidence = await run(client, source, { apply, reviewHash, allowExistingRegionalRules });
    console.log(JSON.stringify({ schemaHash: evidence.schemaHash, safetyBlockers: evidence.safetyBlockers, counts: evidence.counts, executionCounts: evidence.execution.reduce((a, r) => ({ ...a, [r.outcome]: (a[r.outcome] || 0) + 1 }), {}), verification: evidence.verification, directory: DIRECTORY }));
  } finally { await client.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(`Final import failed: ${error.message}. If COMMIT outcome was uncertain, retain the journal and rerun for identity-verified recovery.`); process.exitCode = 1;
});
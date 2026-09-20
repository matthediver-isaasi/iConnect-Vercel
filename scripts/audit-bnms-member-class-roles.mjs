#!/usr/bin/env node
// Evidence only: deliberately no apply mode or write SQL.
import pg from 'pg';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const MAPPING = Object.freeze({
  Associate: 'Associate', Full: 'Full member', 'Full junior': 'Full member junior',
  Trainee: 'Trainee', Student: 'Student', 'Full with NMC': 'Full member',
  'Full junior with NMC': 'Full member junior', 'Overseas Full': 'Full member',
  'Overseas Full junior': 'Full member junior', 'Overseas Full with NMC': 'Full member',
  'Overseas Full junior with NMC': 'Full member junior', Honorary: 'Member',
  Retired: 'Retired', Former: 'Member', 'Department contact': 'Member',
  'Patient representative': 'Patient Representative', 'LMIC Full': 'LMIC Full',
  'LMIC Full junior': 'LMIC Full junior', 'Overseas associate': 'Associate', 'CPD Guest': 'Member',
});
const assert = (condition, message) => { if (!condition) throw new Error(message); };
export const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');

export function roleBlockers(target) {
  const blockers = [];
  if (target.tenant_id !== TENANT || target.is_admin || target.is_tenant_admin
    || !target.excluded_features?.includes('admin')) blockers.push('cross_tenant_or_privileged_target');
  if (target.requires_effective_from_date || target.max_members != null) blockers.push('target_assignment_constraints');
  return blockers;
}

export function planRoles(members, values, roles, memberRoleId) {
  return members.map(member => {
    const rows = values.filter(v => v.member_id === member.id);
    const source = rows.length === 1 ? rows[0].value : null;
    const targetName = Object.hasOwn(MAPPING, source) ? MAPPING[source] : null;
    const targets = roles.filter(r => r.name === targetName);
    const target = targets.length === 1 ? targets[0] : null;
    const blockers = [];
    if (rows.length !== 1 || source == null || source === '') blockers.push('missing_or_ambiguous_class');
    else if (!targetName) blockers.push('unknown_class');
    if (targetName && targets.length !== 1) blockers.push('missing_or_duplicate_target');
    if (target) blockers.push(...roleBlockers(target));
    if (member.role_id !== memberRoleId) blockers.push('secondary_only_requires_review');
    return { member_id: member.id, source, original: member, preferenceRows: rows,
      targetRoleId: target?.id ?? null, targetName,
      action: blockers.length ? 'blocked' : target.id === memberRoleId ? 'unchanged' : 'change', blockers };
  });
}

export async function main(args = process.argv.slice(2)) {
  assert(args.length === 0, 'This audit takes no arguments; applying changes is not supported.');
  const target = destinationTarget(process.env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  assert(response.ok, 'CA download failed');
  const client = new pg.Client({ connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='60s'");
    const read = async (sql, params = []) => (await client.query(sql, params)).rows;
    const transaction = await read("SELECT current_database() AS database, current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation, transaction_timestamp() AS audited_at");
    assert(transaction[0].read_only === 'on', 'Read-only transaction required');
    const tenants = await read('SELECT id,name FROM public.tenant WHERE id=$1', [TENANT]);
    assert(tenants.length === 1 && /bnms|british nuclear medicine society/i.test(tenants[0].name), 'BNMS identity mismatch');
    const roles = await read('SELECT * FROM public.role WHERE tenant_id=$1 ORDER BY id', [TENANT]);
    const base = roles.filter(r => r.name === 'Member');
    assert(base.length === 1, 'Member role missing or ambiguous');
    const fields = await read("SELECT * FROM public.preference_field WHERE tenant_id=$1 AND name='member_class' AND entity_scope='member' AND is_active=true ORDER BY id", [TENANT]);
    assert(fields.length === 1, 'Active member-scoped class field missing or ambiguous');
    const secondaryTable = (await read("SELECT to_regclass('public.member_role') AS relation"))[0].relation;
    // No missing-table fallback: absence is positively established in the catalog.
    const secondary = secondaryTable ? await read(`SELECT to_jsonb(mr) AS data FROM public.member_role mr
      JOIN public.member m ON m.id=mr.member_id WHERE m.tenant_id=$1 ORDER BY mr.member_id,mr.role_id`, [TENANT]) : [];
    const all = await read(`SELECT id,tenant_id,role_id,role_effective_from,organization_id,status,login_enabled,
      member_excluded_features, COALESCE(email ~ '^deleted_.+@deleted[.]local$',false) AS deleted_identity
      FROM public.member WHERE tenant_id=$1 ORDER BY id`, [TENANT]);
    const secondaryIds = new Set(secondary.filter(r => r.data.role_id === base[0].id).map(r => r.data.member_id));
    const rawMembers = all.filter(m => m.role_id === base[0].id || secondaryIds.has(m.id));
    const members = rawMembers.filter(m => !m.deleted_identity);
    const values = await read(`SELECT to_jsonb(v) AS data FROM public.member_preference_value v
      WHERE field_id=$1 AND member_id=ANY($2::uuid[]) ORDER BY member_id,id`, [fields[0].id, members.map(m => m.id)]);
    const triggers = await read(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition,
      pg_get_functiondef(t.tgfoid) AS function FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND c.relname IN ('member','member_role') AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`);
    const plan = planRoles(members, values.map(r => r.data), roles, base[0].id);
    const blockers = [];
    if (members.length !== 2917) blockers.push('expected_population_mismatch');
    if (secondary.length) blockers.push('secondary_associations_require_review_before_execution');
    const mapping = Object.entries(MAPPING).map(([source, targetName]) => {
      const matches = roles.filter(r => r.name === targetName);
      const items = plan.filter(p => p.source === source);
      return { source, targetName, targetRoleId: matches.length === 1 ? matches[0].id : null,
        roleBlockers: matches.length === 1 ? roleBlockers(matches[0]) : ['missing_or_duplicate_target'],
        roleMatches: matches.length, count: items.length, change: items.filter(p => p.action === 'change').length,
        remainMember: items.filter(p => p.action === 'unchanged').length, blocked: items.filter(p => p.action === 'blocked').length };
    });
    const totals = Object.fromEntries(['change', 'unchanged', 'blocked'].map(k => [k, plan.filter(p => p.action === k).length]));
    assert(Object.values(totals).reduce((a,b) => a+b,0) === members.length && new Set(plan.map(p => p.member_id)).size === members.length, 'Accounting mismatch');
    const summary = { mode: 'dry-run-only', database: 'production DEST lvmzliemqnieeoruhkik / postgres',
      transaction: transaction[0], tenant: tenants[0], expected: 2917, cohort: members.length,
      rawMemberRoleRecords: rawMembers.length, excludedDeletedIdentities: rawMembers.filter(m => m.deleted_identity).length,
      totalTenantMembers: all.length, primaryMember: all.filter(m => m.role_id === base[0].id).length,
      secondaryTable, secondaryRows: secondary.length, secondaryOnly: members.filter(m => m.role_id !== base[0].id).length,
      totals, blockers, mapping, unmapped: plan.filter(p => !p.targetName).reduce((acc,p) => { const k=p.source ?? '(missing/ambiguous)'; acc[k]=(acc[k]||0)+1;return acc; }, {}),
      targets: [...new Set(Object.values(MAPPING))].map(name => ({ name, count: plan.filter(p => p.targetName === name).length })),
      writes: 0, migrations: 0, readyToApply: false };
    const evidence = { summary, roles, fields, secondary, triggers, excludedDeleted: rawMembers.filter(m => m.deleted_identity), plan };
    const directory = path.join(homedir(), '.private-recovery', 'bnms-role-audit', new Date().toISOString().replaceAll(':','-'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(directory,'snapshot.json'), JSON.stringify(evidence,null,2), { flag:'wx', mode:0o600 });
    const report = { ...summary, planSha256: digest(plan), evidenceSha256: digest(evidence), evidenceDirectory: directory };
    writeFileSync(path.join(directory,'summary.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
    await client.query('ROLLBACK');
    console.log(JSON.stringify(report,null,2));
  } catch(error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Read-only BNMS audit failed; no changes applied.'); process.exitCode=1; });
}
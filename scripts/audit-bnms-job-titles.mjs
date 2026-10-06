import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connectDestination, PROJECT } from './annual-meeting-destination.mjs';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const DIRECTORY = 'private/bnms-job-title-audit';
export function savePrivate(name, value) {
  execFileSync('git', ['check-ignore', '-q', `${DIRECTORY}/${name}`]);
  fs.mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${DIRECTORY}/${name}`, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
}

async function main() {
  if (process.argv.length !== 2) throw Error('Read-only audit accepts no arguments');
  const db = await connectDestination();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL statement_timeout='60s'");
    const q = async (sql, values = []) => (await db.query(sql, values)).rows;
    const tenant = await q('select id,name from public.tenant where id=$1', [TENANT]);
    assert.equal(tenant.length, 1); assert.equal(tenant[0].name, 'BNMS');
    const [{ total }] = await q('select count(*)::int total from public.member where tenant_id=$1', [TENANT]);
    const members = [];
    let cursor = null;
    for (;;) {
      const page = await q('select to_jsonb(m) record from public.member m where tenant_id=$1 and ($2::uuid is null or id>$2::uuid) order by id limit 500', [TENANT, cursor]);
      members.push(...page.map(r => r.record));
      if (page.length < 500) break;
      cursor = members.at(-1).id;
    }
    assert.equal(members.length, total); assert.equal(new Set(members.map(m => m.id)).size, total);
    const notes = await q('select to_jsonb(n) record from public.member_note n join public.member m on m.id::text=n.target_member_id where m.tenant_id=$1 order by n.id', [TENANT]);
    const legacy = await q('select p.member_id,p.value from public.member_preference_value p join public.member m on m.id=p.member_id where m.tenant_id=$1 and p.field_id=$2 order by p.id', [TENANT, '50d7b71c-29b0-4d4c-a817-f39edf35f2e0']);
    const groups = await q('select id,automatic_membership_enabled,automatic_membership_filter_groups from public.member_group where tenant_id=$1 order by id', [TENANT]);
    const triggers = await q("select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition,pg_get_functiondef(t.tgfoid) function from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('member','member_note') and not t.tgisinternal order by c.relname,t.tgname");
    const columns = await q("select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name in ('member','member_note') order by table_name,ordinal_position");
    const historyTables = await q("select table_name from information_schema.tables where table_schema='public' and (table_name like '%import%' or table_name like '%member%history%' or table_name like '%audit%') order by table_name");
    savePrivate('snapshot.json', { project: PROJECT, tenant: tenant[0], capturedAt: new Date().toISOString(), total, members, notes: notes.map(r => r.record), legacy, groups });
    savePrivate('schema.json', { columns, triggers, historyTables });
    console.log(JSON.stringify({ destinationVerified: true, reviewedCount: total, blank: members.filter(m => !m.job_title?.trim()).length, nonblank: members.filter(m => m.job_title?.trim()).length, enabledGroups: groups.filter(g => g.automatic_membership_enabled).length, triggerNames: triggers.map(t => t.tgname), historyTables: historyTables.map(t => t.table_name), writes: 0 }));
  } finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); }
}
if (process.argv[1]?.endsWith('/audit-bnms-job-titles.mjs')) main().catch(error => { console.error('Audit failed; no writes attempted.', { code: error.code, detail: error.code === '42703' || error.code === '42883' ? error.message : 'Inspect target/schema prerequisites without logging member data.' }); process.exitCode = 1; });

#!/usr/bin/env node
// Dry-run first. Apply requires the exact dry-run plan hash and explicit metadata
// consent. Never imports application modules or calls notification/provider APIs.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, chmodSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDestination, PROJECT } from './import-bnms-final-members.mjs';
import { FILE, HASH, FIELD, TENANT, parseSource, reconcile } from './bnms-student-dates-source.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const assert = (ok, message) => { if (!ok) throw Error(message); };
const DIRECTORY = 'private/bnms-student-dates';
// Filled only after reviewing the live trigger entry points and reachable helpers.
const REVIEWED_SCHEMA = '28a331109161e35ad0ca27942d0588efc4ff95eba4438ab0ef0d64222c6e5c37';

export function saveEvidence(name, value) {
  assert(/^[a-z0-9-]+\.json$/.test(name), 'Invalid evidence name');
  execFileSync('git', ['check-ignore', '-q', `${DIRECTORY}/${name}`]);
  execFileSync('git', ['check-ignore', '-q', FILE]);
  assert(!execFileSync('git', ['ls-files', '--', FILE, DIRECTORY], { encoding: 'utf8' }).trim(),
    'Private source/evidence must not be tracked');
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 });
  chmodSync(DIRECTORY, 0o700);
  const fd = openSync(`${DIRECTORY}/${name}`, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(DIRECTORY, 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export async function schemaEvidence(db) {
  const query = async sql => (await db.query(sql)).rows;
  return {
    triggers: await query(`select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition,
      pg_get_functiondef(t.tgfoid) body from pg_trigger t join pg_class c on c.oid=t.tgrelid
      where c.relnamespace='public'::regnamespace and c.relname in ('member','member_preference_value')
      and not t.tgisinternal order by 1,2`),
    helpers: await query(`select proname,pg_get_functiondef(oid) body from pg_proc
      where pronamespace='public'::regnamespace and proname in
      ('department_current_set_auth_lock','queue_automatic_memberships_for_source_changes') order by 1,2`),
    columns: await query(`select table_name,column_name,data_type,is_nullable,column_default
      from information_schema.columns where table_schema='public'
      and table_name in ('member','member_preference_value') order by table_name,ordinal_position`),
    constraints: await query(`select conrelid::regclass::text relation,conname,pg_get_constraintdef(oid) definition
      from pg_constraint where conrelid in ('public.member'::regclass,'public.member_preference_value'::regclass)
      order by 1,2`),
    rules: await query(`select * from pg_rules where schemaname='public'
      and tablename in ('member','member_preference_value') order by tablename,rulename`),
  };
}

export async function loadState(db, rows) {
  const tenant = (await db.query('select id,name from public.tenant where id=$1', [TENANT])).rows;
  assert(tenant.length === 1 && tenant[0].name === 'BNMS', 'Tenant mismatch');
  const fields = (await db.query(`select to_jsonb(f) row from public.preference_field f where id=$1
    or (tenant_id=$2 and entity_scope='member' and (name='student_course_end_date' or label='Student course end date'))`,
  [FIELD, TENANT])).rows.map(r => r.row);
  const f = fields[0];
  assert(fields.length === 1 && f.id === FIELD && f.tenant_id === TENANT
    && f.name === 'student_course_end_date' && f.label === 'Student course end date'
    && f.field_type === 'date' && f.entity_scope === 'member' && f.is_active === true
    && f.custom_object_id == null && f.is_read_only !== true && f.is_writable !== false
    && (f.options == null || (Array.isArray(f.options) && !f.options.length)), 'Field mismatch');
  const ids = rows.filter(r => !r.reasons.length).map(r => r.member_id);
  const members = (await db.query('select to_jsonb(m) row from public.member m where id=any($1::uuid[]) order by id', [ids])).rows.map(r => r.row);
  const preferences = (await db.query('select to_jsonb(p) row from public.member_preference_value p where member_id=any($1::uuid[]) order by id', [ids])).rows.map(r => r.row);
  const groups = (await db.query('select to_jsonb(g) row from public.member_group g where tenant_id=$1 order by id', [TENANT])).rows.map(r => r.row);
  // Match the reviewed SQL helper's exact field dependency. No group queue or
  // reconciliation is authorized, even when it would only touch this tenant.
  assert(!groups.some(g => g.automatic_membership_enabled && JSON.stringify(g.automatic_membership_filter_groups).includes(FIELD)),
    'Course-end field participates in automatic membership rules');
  return { fields, members, preferences, groups };
}

export function planFor(source, state, schemaHash) {
  const rows = reconcile(source.rows, state.members, state.preferences);
  return { project: PROJECT, tenant: TENANT, field: FIELD, fingerprint: source.fingerprint,
    schemaHash, beforeHash: digest(state), rows,
    counts: Object.fromEntries(['update', 'unchanged', 'held'].map(k => [k, rows.filter(r => r.outcome === k).length])) };
}

export function assertReview(plan, reviewHash, allowMetadataEffects) {
  assert(allowMetadataEffects, 'Apply requires explicit metadata-effects consent');
  assert(digest(plan) === reviewHash, 'Preflight changed; rerun dry-run and review before applying');
}

export async function applyRows(db, rows) {
  const changed = rows.filter(r => r.outcome === 'update');
  const updates = changed.filter(r => r.before.length);
  const inserts = changed.filter(r => !r.before.length).map(r => ({ ...r, id: randomUUID() }));
  if (updates.length) {
    const result = await db.query(`update public.member_preference_value p set value=r.value,updated_at=now()
      from jsonb_to_recordset($1::jsonb) r(member_id uuid,value text,before jsonb)
      where p.member_id=r.member_id and p.field_id=$2 and to_jsonb(p)=r.before->0
      and exists(select 1 from public.member m where m.id=p.member_id and m.tenant_id=$3)
      returning p.id`, [JSON.stringify(updates), FIELD, TENANT]);
    assert(result.rowCount === updates.length, 'Before-value update conflict');
  }
  if (inserts.length) {
    const result = await db.query(`insert into public.member_preference_value(id,member_id,field_id,value)
      select r.id,r.member_id,$2,r.value from jsonb_to_recordset($1::jsonb) r(id uuid,member_id uuid,value text)
      join public.member m on m.id=r.member_id and m.tenant_id=$3
      where not exists(select 1 from public.member_preference_value p where p.member_id=r.member_id and p.field_id=$2)
      returning id`, [JSON.stringify(inserts), FIELD, TENANT]);
    assert(result.rowCount === inserts.length, 'Before-value insert conflict');
  }
  return changed.length;
}

export function verifyPreservation(before, after, rows) {
  const changed = new Set(rows.filter(r => r.outcome === 'update').map(r => r.member_id));
  const strip = m => {
    if (!changed.has(m.id)) return m;
    const { updated_at, survey_invitation_revision, ...rest } = m;
    return rest;
  };
  assert(digest(before.members.map(strip)) === digest(after.members.map(strip)), 'Unrelated member data changed');
  for (const m of before.members.filter(m => changed.has(m.id))) {
    const next = after.members.find(n => n.id === m.id);
    assert(BigInt(next.survey_invitation_revision) === BigInt(m.survey_invitation_revision) + 1n,
      'Unexpected survey revision effect');
  }
  const unmanaged = p => !changed.has(p.member_id) || p.field_id !== FIELD;
  assert(digest(before.preferences.filter(unmanaged)) === digest(after.preferences.filter(unmanaged)), 'Unrelated preference data changed');
  assert(digest(before.groups) === digest(after.groups), 'Group data changed');
  assert(digest(before.fields) === digest(after.fields), 'Field metadata changed');
}

export async function run(db, source, { apply = false, reviewHash, allowMetadataEffects = false } = {}) {
  assert(source.fingerprint === HASH && source.rows.length === 30, 'Unapproved source');
  const runId = `${Date.now()}-${randomUUID()}`;
  let committed = false;
  await db.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
    if (apply) {
      // Prevent absent-row insert races, ownership changes, and rule changes
      // during this short bounded transaction; no trigger is disabled.
      await db.query('LOCK TABLE public.member,public.member_preference_value,public.member_group IN SHARE ROW EXCLUSIVE MODE');
      await db.query('LOCK TABLE public.tenant,public.preference_field IN SHARE MODE');
    }
    const schema = await schemaEvidence(db), schemaHash = digest(schema);
    saveEvidence(`schema-${runId}.json`, schema);
    assert(schemaHash === REVIEWED_SCHEMA, `Unreviewed schema: ${schemaHash}`);
    const before = await loadState(db, source.rows), plan = planFor(source, before, schemaHash);
    saveEvidence(`plan-${runId}.json`, { plan, before, reviewHash: digest(plan) });
    if (!apply) {
      await db.query('ROLLBACK');
      return { mode: 'dry-run', ...plan.counts, reviewHash: digest(plan) };
    }
    assertReview(plan, reviewHash, allowMetadataEffects);
    // Immutable, fsynced before-images persist even if COMMIT acknowledgment is lost.
    saveEvidence(`intent-${runId}.json`, { plan, before, metadataEffectsAuthorized: true,
      rollback: 'Do not rewind survey revisions. Under the same target/tenant/field locks, compare current rows with verified-after evidence; restore each previous preference value, or delete an originally absent row only by its recorded post-write ID and value. Abort on drift. A rollback triggers ordinary timestamps/revisions and needs separate execution approval.' });
    const updated = await applyRows(db, plan.rows);
    const after = await loadState(db, source.rows);
    verifyPreservation(before, after, plan.rows);
    const replay = reconcile(source.rows, after.members, after.preferences);
    assert(replay.every((r, i) => plan.rows[i].outcome === 'held' ? r.outcome === 'held' : r.outcome === 'unchanged'),
      'Post-write reconciliation failed');
    assert(digest(await schemaEvidence(db)) === schemaHash, 'Schema changed during import');
    saveEvidence(`verified-${runId}.json`, { plan, before, after, replay, committed: false });
    await db.query('COMMIT');
    committed = true;
    // New transaction, fresh destination snapshot (not the pre-commit read).
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const fresh = await loadState(db, source.rows);
    const freshRows = reconcile(source.rows, fresh.members, fresh.preferences);
    assert(freshRows.every((r, i) => plan.rows[i].outcome === 'held' ? r.outcome === 'held' : r.outcome === 'unchanged'),
      'Committed but fresh verification failed; retain evidence');
    await db.query('ROLLBACK');
    const summary = { mode: 'applied', updated, unchanged: plan.counts.unchanged, held: plan.counts.held,
      verified: freshRows.filter(r => r.outcome === 'unchanged').length, committed: true };
    saveEvidence(`result-${runId}.json`, { summary, fresh, freshRows, verifiedAt: new Date().toISOString() });
    return summary;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    if (committed) throw Error(`Import committed; verification incomplete. Preserve private evidence. ${error.message}`);
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  assert(new Set(args).size === args.length && args.every(a =>
    ['--apply', '--allow-metadata-effects'].includes(a) || /^--review-sha256=[a-f0-9]{64}$/.test(a)), 'Invalid arguments');
  const source = parseSource(readFileSync(FILE));
  const db = await connectDestination();
  try {
    console.log(JSON.stringify(await run(db, source, { apply: args.includes('--apply'),
      allowMetadataEffects: args.includes('--allow-metadata-effects'),
      reviewHash: args.find(a => a.startsWith('--review-sha256='))?.split('=')[1] })));
  } finally { await db.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

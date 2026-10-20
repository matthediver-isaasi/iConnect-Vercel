// Offline by default; read-only preflight; exact SQL hash required for application.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { hash } from './prepare-bnms-five-members.mjs';

export const MIGRATION = '20261020090000_member_history_payment_unverified.sql';
export const BASE_SCHEMA_HASH = '05c88b3be37e121e2963ded879f00f640d5e71cb7b63ae624ec11388693a4c9e';
const CONSTRAINT = 'member_membership_history_payment_status_chk';
const ORIGINAL = "CHECK ((payment_status = ANY (ARRAY['unpaid'::text, 'paid'::text, 'partial'::text, 'voided'::text])))";
const EXTENDED = "CHECK ((payment_status = ANY (ARRAY['unpaid'::text, 'paid'::text, 'partial'::text, 'voided'::text, 'unverified'::text])))";
const GUARDS = ['member_history_payment_unverified_after','member_history_payment_unverified_before'];
export const migrationSql = () => readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
export const sqlHash = sql => createHash('sha256').update(sql).digest('hex');
export const ident = value => {
  assert.ok(/^[a-z][a-z0-9_]*$/.test(value), 'Unexpected SQL identifier');
  return `"${value}"`;
};
export async function inspectSchema(db) {
  const result = {};
  for (const [key, sql] of Object.entries({
    columns: `SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='member_membership_history' ORDER BY ordinal_position`,
    constraints: `SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint
      WHERE conrelid='public.member_membership_history'::regclass ORDER BY conname`,
    triggers: `SELECT tgname,tgenabled,pg_get_triggerdef(t.oid) definition,pg_get_functiondef(t.tgfoid) function
      FROM pg_trigger t WHERE tgrelid='public.member_membership_history'::regclass AND NOT tgisinternal ORDER BY tgname`,
    indexes: `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public'
      AND tablename='member_membership_history' ORDER BY indexname`,
  })) result[key] = (await db.query(sql)).rows;
  return result;
}
export function assertInstalled(schema, sql) {
  const original = structuredClone(schema);
  const constraint = original.constraints.find(c => c.conname === CONSTRAINT);
  assert.equal(constraint?.definition, EXTENDED, 'Unreviewed payment status constraint');
  constraint.definition = ORIGINAL;
  const body = sql.split('AS $function$')[1]?.split('$function$;')[0];
  assert.ok(body);
  for (const name of GUARDS) {
    const trigger = original.triggers.find(t => t.tgname === name);
    assert.equal(trigger?.tgenabled, 'O', 'Unverified guard disabled or missing');
    const when = name.endsWith('_before') ? 'BEFORE INSERT OR DELETE OR UPDATE' : 'AFTER INSERT OR UPDATE';
    assert.equal(trigger.definition, `CREATE TRIGGER ${name} ${when} ON public.member_membership_history FOR EACH ROW EXECUTE FUNCTION guard_member_history_payment_unverified()`);
    assert.equal(trigger.function.split('AS $function$')[1]?.split('$function$')[0], body, 'Unreviewed guard body');
    assert.ok(trigger.function.includes("SET search_path TO 'pg_catalog'"));
    assert.ok(!trigger.function.includes('SECURITY DEFINER'));
  }
  original.triggers = original.triggers.filter(t => !GUARDS.includes(t.tgname));
  assert.equal(hash(original), BASE_SCHEMA_HASH, 'Pre-existing columns/defaults/constraints/triggers/indexes changed');
}
export async function assertGuardPrivileges(db) {
  const result = (await db.query(`SELECT
    has_function_privilege('anon','public.guard_member_history_payment_unverified()','EXECUTE') anon,
    has_function_privilege('authenticated','public.guard_member_history_payment_unverified()','EXECUTE') authenticated,
    has_function_privilege('service_role','public.guard_member_history_payment_unverified()','EXECUTE') service_role,
    EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid='public.guard_member_history_payment_unverified()'::regprocedure
      AND a.grantee=0 AND a.privilege_type='EXECUTE') public_execute`)).rows[0];
  assert.deepEqual(result, { anon: false, authenticated: false, service_role: true, public_execute: false },
    'Unverified guard execution privileges changed');
}
export async function historySnapshot(db) {
  return (await db.query('SELECT to_jsonb(h) data FROM public.member_membership_history h ORDER BY id')).rows.map(r => {
    const row = r.data;
    for (const key of ['created_at','updated_at','paid_at']) {
      if (row[key] != null) row[key] = new Date(row[key]).toISOString();
    }
    return row;
  });
}
export async function runMigration(db, sql, { apply = false } = {}) {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    await db.query('LOCK TABLE public.member_membership_history IN ACCESS EXCLUSIVE MODE');
    const before = await historySnapshot(db);
    const schema = await inspectSchema(db);
    const installed = schema.triggers.some(t => GUARDS.includes(t.tgname));
    if (installed) {
      assertInstalled(schema, sql);
      await assertGuardPrivileges(db);
    }
    else {
      assert.equal(hash(schema), BASE_SCHEMA_HASH, 'Actual destination schema changed; re-review');
      await db.query(sql);
      assertInstalled(await inspectSchema(db), sql);
      await assertGuardPrivileges(db);
    }
    assert.deepEqual(await historySnapshot(db), before, 'Migration changed existing history records');
    await db.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { installedPreviously: installed, applied: apply && !installed, rollback: !apply,
      historyRows: before.length, historyHash: hash(before), protectedHistoryUnchanged: true };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
export async function main(args = process.argv.slice(2)) {
  const sql = await migrationSql(), sha256 = sqlHash(sql);
  if (!args.length) {
    console.log(JSON.stringify({ migration: MIGRATION, sha256, writesPerformed: false }));
    return;
  }
  assert.ok(args.length === 1 && args[0] === '--preflight'
    || args.length === 2 && args[0] === '--apply' && args[1] === `--review-sha256=${sha256}`,
  'Use --preflight or --apply --review-sha256=<exact reviewed SQL hash>');
  const { connectDestination } = await import('./annual-meeting-destination.mjs');
  const db = await connectDestination();
  try {
    if (args[0] === '--preflight') {
      await db.query('BEGIN READ ONLY');
      const schema = await inspectSchema(db);
      const installed = schema.triggers.some(t => GUARDS.includes(t.tgname));
      if (installed) {
        assertInstalled(schema, sql);
        await assertGuardPrivileges(db);
      }
      else assert.equal(hash(schema), BASE_SCHEMA_HASH);
      const rows = await historySnapshot(db);
      await db.query('ROLLBACK');
      console.log(JSON.stringify({ readOnly: true, installed, schemaHash: hash(schema), historyRows: rows.length,
        historyHash: hash(rows), sha256, writesPerformed: false }));
    } else {
      const rehearsal = await runMigration(db, sql);
      const applied = await runMigration(db, sql, { apply: true });
      const replay = await runMigration(db, sql);
      console.log(JSON.stringify({ sha256, rehearsal, applied, replay }));
    }
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message.split('\n')[0]); process.exitCode = 1; });
}

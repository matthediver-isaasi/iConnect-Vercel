#!/usr/bin/env node
// Offline review by default. Explicit destination-only rehearsal/apply/verify.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const migrationPath = 'supabase/migrations/202701220001_membership_structure_handover.sql';
export const gfi = {
  tenant: 'fd82da65-aab7-4a5c-85b8-b2febeb2003d',
  field: 'e5ac547d-edb1-4ff1-83ab-fc82c1813065',
  ids: ['8a0c4c3d-05d1-4d33-9b08-66f0d772cae3', '696d519c-31af-43b9-983f-fa68a31ffa16', 'e2c49e80-c08d-4d82-bd3d-9f37b874fd31'],
};
const operation = 'gfi-university-approved-2026-07-31';
export async function connectDestination(env = process.env) {
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Provider CA unavailable');
  const db = new pg.Client({ connectionString: target.toString(), connectionTimeoutMillis: 15000,
    ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
  await db.connect();
  return db;
}
export async function readUniversity(db) {
  return (await db.query(`SELECT to_jsonb(c) row FROM public.membership_tier_config c
    WHERE tenant_id=$1 AND structure_scope_type='organization' AND structure_field_id=$2
      AND lower(btrim(structure_match_value))='university' ORDER BY effective_from NULLS FIRST,id`,
  [gfi.tenant, gfi.field])).rows.map(r => r.row);
}
export function verifyUniversity(rows, corrected = false) {
  const starts = ['2025-08-01', '2026-08-01', '2026-11-19'];
  const ends = [corrected ? '2026-07-31' : '2027-07-31', '2026-11-18', null];
  if (rows.length !== 3 || rows.some((r, i) => r.id !== gfi.ids[i]
    || r.tenant_id !== gfi.tenant || r.structure_scope_type !== 'organization'
    || r.structure_field_id !== gfi.field || r.structure_match_value !== 'University'
    || r.effective_from !== starts[i] || r.effective_to !== ends[i]
    || r.membership_start_month !== 8 || r.membership_start_day !== 1
    || r.start_mode !== 'fixed_date' || r.is_active !== true)) {
    throw new Error('GFI timeline differs from the approved three-version contract. Stop for clarification.');
  }
}
export async function correctUniversity(db) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('membership-structure:' || $1::text,0))", [gfi.tenant]);
  const before = await readUniversity(db);
  if (before[0]?.effective_to === '2026-07-31') {
    verifyUniversity(before, true);
    const evidence = (await db.query(`SELECT before_schedule,after_schedule FROM public.membership_structure_schedule_audit
      WHERE tenant_id=$1 AND operation=$2 ORDER BY created_at DESC LIMIT 1`, [gfi.tenant, operation])).rows[0];
    if (!evidence || JSON.stringify(evidence.after_schedule) !== JSON.stringify(before)) {
      throw new Error('Corrected boundary exists without matching audit evidence; review before replay.');
    }
    return { changed: false, boundary: '2026-07-31' };
  }
  verifyUniversity(before);
  const result = await db.query(`UPDATE public.membership_tier_config SET effective_to='2026-07-31'
    WHERE id=$1 AND tenant_id=$2 AND effective_to='2027-07-31'`, [gfi.ids[0], gfi.tenant]);
  if (result.rowCount !== 1) throw new Error('Correction boundary changed concurrently');
  const after = await readUniversity(db);
  verifyUniversity(after, true);
  const expected = structuredClone(before);
  expected[0].effective_to = '2026-07-31';
  if (JSON.stringify(after) !== JSON.stringify(expected)) throw new Error('Unexpected configuration changes');
  await db.query(`INSERT INTO public.membership_structure_schedule_audit
    (tenant_id,operation,before_schedule,after_schedule) VALUES($1,$2,$3,$4)`,
  [gfi.tenant, operation, JSON.stringify(before), JSON.stringify(after)]);
  return { changed: true, configId: gfi.ids[0], from: '2027-07-31', to: '2026-07-31' };
}
export async function verifySchema(db) {
  const sql = await readFile(migrationPath, 'utf8');
  for (const name of ['membership_structure_scope','lock_membership_structure_schedule',
    'check_membership_structure_schedule','save_membership_structure']) {
    const body = sql.split(`FUNCTION public.${name}(`)[1]?.split(' AS $$')[1]?.split('$$;')[0];
    const functions = (await db.query(`SELECT prosrc FROM pg_proc
      WHERE pronamespace='public'::regnamespace AND proname=$1`, [name])).rows;
    if (!body || functions.length !== 1 || functions[0].prosrc !== body) throw new Error('Schedule function body differs from reviewed SQL');
  }
  const { rows } = await db.query(`SELECT p.prosecdef,
    has_function_privilege('service_role',p.oid,'EXECUTE') service,
    has_function_privilege('anon',p.oid,'EXECUTE') anon,
    has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated
    FROM pg_proc p WHERE p.oid=to_regprocedure('public.save_membership_structure(uuid,uuid,jsonb,jsonb)')`);
  if (rows.length !== 1 || !rows[0].prosecdef || !rows[0].service || rows[0].anon || rows[0].authenticated) {
    throw new Error('Atomic save grants do not match the reviewed contract');
  }
  const triggers = await db.query(`SELECT tgname,tgenabled,tgdeferrable,tginitdeferred FROM pg_trigger
    WHERE tgrelid='public.membership_tier_config'::regclass
      AND tgname IN ('membership_structure_schedule_check','membership_structure_schedule_lock')`);
  if (triggers.rowCount !== 2 || triggers.rows.some(t => t.tgenabled !== 'O')
    || !triggers.rows.find(t => t.tgname === 'membership_structure_schedule_check' && t.tgdeferrable && t.tginitdeferred)) {
    throw new Error('Schedule guards are not enabled');
  }
}
export async function main(args = process.argv.slice(2)) {
  if (args.some(a => !['--rehearse','--apply','--verify','--correct-gfi'].includes(a) && !/^--review-sha256=[a-f0-9]{64}$/.test(a))
    || args.filter(a => ['--rehearse','--apply','--verify'].includes(a)).length > 1) throw new Error('Invalid arguments');
  const sql = await readFile(migrationPath, 'utf8');
  const correction = args.includes('--correct-gfi');
  const runner = await readFile(new URL(import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).update(runner).update(String(correction)).digest('hex');
  const report = { project: 'lvmzliemqnieeoruhkik', migrationPath, sha256, correction };
  if (!args.some(a => ['--rehearse','--apply','--verify'].includes(a))) {
    console.log(JSON.stringify({ ...report, offline: true, change: correction ? { id: gfi.ids[0], before: '2027-07-31', after: '2026-07-31' } : 'schema only' }));
    return;
  }
  const write = args.includes('--apply');
  if ((write || args.includes('--rehearse')) && !args.includes(`--review-sha256=${sha256}`)) throw new Error('Reviewed hash required');
  const db = await connectDestination();
  try {
    await db.query(args.includes('--verify') ? 'BEGIN READ ONLY' : 'BEGIN');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='90s'");
    const snapshot = async () => (await db.query('SELECT to_jsonb(c) row FROM public.membership_tier_config c ORDER BY id')).rows.map(r => r.row);
    const allBefore = await snapshot();
    if (!args.includes('--verify')) await db.query(sql);
    await verifySchema(db);
    let result;
    if (correction && !args.includes('--verify')) result = await correctUniversity(db);
    if (correction && args.includes('--verify')) verifyUniversity(await readUniversity(db), true);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    const expected = structuredClone(allBefore);
    if (result?.changed) expected.find(r => r.id === gfi.ids[0]).effective_to = '2026-07-31';
    if (JSON.stringify(await snapshot()) !== JSON.stringify(expected)) throw new Error('Unexpected changes outside the approved schedule boundary');
    await db.query(write ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ ...report, applied: write, verified: true, result }));
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e instanceof pg.DatabaseError ? { error: 'Destination transaction failed', code: e.code } : { error: e.message }); process.exitCode = 1; });
}

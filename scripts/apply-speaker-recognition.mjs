#!/usr/bin/env node
// No credentials or network access on the default, offline review path.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const migrationPath = 'supabase/migrations/20261124_speaker_recognition.sql';
export const historyMigrationPath = 'supabase/migrations/20261124_speaker_recognition_history.sql';
export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => !['--apply', '--preflight'].includes(arg) && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || (args.includes('--apply') && args.includes('--preflight'))) throw new Error('Use --preflight or --apply --review-sha256=<hash>; default is offline review.');
  const sql = (await Promise.all([migrationPath, historyMigrationPath]
    .map(path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')))).join('\n;\n');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  const report = { migrations: [migrationPath, historyMigrationPath], destinationProject: 'lvmzliemqnieeoruhkik', sha256 };
  if (!args.includes('--apply') && !args.includes('--preflight')) {
    console.log(JSON.stringify({ ...report, dryRun: true, writesPerformed: false }));
    return;
  }
  if (args.includes('--apply') && !args.includes(`--review-sha256=${sha256}`)) throw new Error('Exact reviewed migration hash required; no database changed.');
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Destination CA download failed; no database changed.');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination CA; no database changed.');
  const client = new pg.Client({ connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname } });
  await client.connect();
  try {
    await client.query(args.includes('--preflight') ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    const identity = (await client.query(`SELECT current_database()='postgres' AS database_ok,
      to_regclass('public.speaker_award_grant') IS NOT NULL AS grants_ok,
      to_regclass('public.cpd_certificate_template') IS NOT NULL AS templates_ok,
      to_regclass('public.cpd_certificate_placeholder') IS NOT NULL AS placeholders_ok,
      to_regclass('storage.buckets') IS NOT NULL AS storage_ok`)).rows[0];
    if (Object.values(identity).some(value => value !== true)) throw new Error('Destination schema identity check failed');
    if (args.includes('--preflight')) {
      const columnTypes = (await client.query(`SELECT table_name,column_name,data_type,udt_name
        FROM information_schema.columns WHERE table_schema='public'
        AND table_name IN ('event','event_agenda_item','complex_event_session')
        AND column_name='speaker_ids' ORDER BY table_name LIMIT 3`)).rows;
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ ...report, preflight: true, identity, columnTypes, writesPerformed: false }));
      return;
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext('speaker-recognition-migration'))");
    await client.query(sql);
    const guards = (await client.query(`SELECT
      NOT has_function_privilege('authenticated','public.sync_speaker_recognition(uuid,text,uuid)','EXECUTE') AS sync_private,
      NOT has_function_privilege('anon','public.finish_speaker_certificate(uuid,uuid,text,text)','EXECUTE') AS finish_private,
      NOT has_function_privilege('anon','public.refresh_speaker_recognition_badges()','EXECUTE') AS refresh_anon_private,
      NOT has_function_privilege('authenticated','public.refresh_speaker_recognition_badges()','EXECUTE') AS refresh_member_private,
      has_function_privilege('service_role','public.refresh_speaker_recognition_badges()','EXECUTE') AS refresh_service,
      NOT has_table_privilege('anon','public.speaker_award_history','SELECT') AS history_anon_private,
      NOT has_table_privilege('authenticated','public.speaker_award_history','SELECT') AS history_member_private,
      has_table_privilege('service_role','public.speaker_award_history','SELECT') AS history_service,
      NOT public AS bucket_private FROM storage.buckets WHERE id='speaker-certificates'`)).rows[0];
    if (!guards || Object.values(guards).some(value => value !== true)) throw new Error('Speaker recognition privacy verification failed');
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log(JSON.stringify({ ...report, applied: true, guards, retrospectiveIssuance: false }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // Locate failures without printing database messages, literals, row details,
    // connection parameters or other potentially sensitive server context.
    const position = Number(error.position);
    const line = Number.isInteger(position) && position > 0
      ? sql.slice(0, position - 1).split('\n').length : null;
    throw new Error(`Speaker recognition migration failed (${error.code || 'validation'}${line ? `, combined SQL line ${line}` : ''}); transaction rolled back.`);
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
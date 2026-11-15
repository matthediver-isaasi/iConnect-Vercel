#!/usr/bin/env node
// Offline by default. Never uses SOURCE or implicitly applies on import.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '202701250001_project_comment_images.sql';
export const SHA256 = 'b4c78fdc9dd038427aa51b4a4f92b6b1e64d976aab870398279771108d367b01';
const signature = 'public.create_project_comment_with_images(uuid,uuid,text,uuid[],uuid[],uuid)';
export async function main(args = process.argv.slice(2), env = process.env) {
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const hash = createHash('sha256').update(sql).digest('hex');
  if (hash !== SHA256) throw new Error('Pinned migration content changed; no database was changed.');
  if (!args.length) return console.log(JSON.stringify({ migration: MIGRATION, sha256: hash, dryRun: true, writesPerformed: false }));
  if (args.length !== 2 || args[0] !== '--apply' || args[1] !== `--review-sha256=${hash}`) {
    throw new Error('Use --apply with the exact reviewed SHA; no database was changed.');
  }
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Unable to load destination TLS certificate.');
  const ca = await response.text();
  const client = new pg.Client({ connectionString: target.toString(), ssl: { rejectUnauthorized: true, ca, servername: target.hostname } });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('project-comment-images-migration'))");
    const { rows: prior } = await client.query(
      "SELECT to_regprocedure($1) AS fn, obj_description(to_regprocedure($1),'pg_proc') AS receipt", [signature]);
    if (prior[0].fn) {
      if (prior[0].receipt !== `migration-sha256:${hash}`) throw new Error('Existing image function lacks the matching migration receipt; inspect before retrying.');
    } else {
      // Keep schema and verification in ONE transaction, unlike executing a
      // nested BEGIN/COMMIT that would commit before postflight checks.
      await client.query(sql.replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, ''));
      await client.query(`COMMENT ON FUNCTION ${signature} IS 'migration-sha256:${hash}'`);
    }
    const { rows } = await client.query(`SELECT
      has_function_privilege('service_role',$1,'EXECUTE')
      AND NOT has_function_privilege('authenticated',$1,'EXECUTE')
      AND NOT has_function_privilege('anon',$1,'EXECUTE')
      AND NOT has_table_privilege('authenticated','public.project_comment_image','INSERT')
      AND NOT has_table_privilege('anon','public.project_activity_upload','SELECT')
      AND (SELECT relrowsecurity FROM pg_class WHERE oid='public.project_comment_image'::regclass)
      AND (SELECT relrowsecurity FROM pg_class WHERE oid='public.project_activity_upload'::regclass)
      AS verified`, [signature]);
    if (!rows[0]?.verified) throw new Error('Image schema access verification failed.');
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log('Project Activity image migration applied and verified.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Project Activity image migration failed; no credentials logged.'); process.exitCode = 1; });
}

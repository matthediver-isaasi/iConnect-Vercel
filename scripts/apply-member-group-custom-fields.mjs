import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const migrationUrl = new URL('../supabase/migrations/202612080001_member_group_custom_fields.sql', import.meta.url);
export async function runMigration(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const { rows } = await client.query(`SELECT
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='member_group' AND column_name='custom_field_values' AND data_type='jsonb') AS values_column,
      EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='member_group_custom_fields_setting_singleton') AS singleton,
      NOT has_function_privilege('anon','public.save_member_group_custom_fields(uuid,jsonb,integer)','EXECUTE')
      AND NOT has_function_privilege('authenticated','public.save_member_group_custom_fields(uuid,jsonb,integer)','EXECUTE')
      AND has_function_privilege('service_role','public.save_member_group_custom_fields(uuid,jsonb,integer)','EXECUTE') AS protected_rpc`);
    if (!Object.values(rows[0]).every(Boolean)) throw new Error('Migration verification failed');
    await client.query('COMMIT');
    return rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(a => !['--apply', '--preflight'].includes(a) && !/^--review-sha256=[a-f0-9]{64}$/.test(a))) throw new Error('Invalid arguments');
  const sql = await readFile(migrationUrl, 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply') && !args.includes('--preflight')) {
    console.log(JSON.stringify({ dryRun: true, migration: migrationUrl.pathname.split('/').pop(), sha256 }));
    return;
  }
  if (args.includes('--apply') && !args.includes(`--review-sha256=${sha256}`)) throw new Error('Reviewed SQL hash required');
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Verified TLS certificate unavailable');
  const client = new pg.Client({ connectionString: target.toString(), ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
  try {
    await client.connect();
    await client.query('SELECT id,tenant_id,setting_key,setting_value FROM public.system_settings LIMIT 0');
    await client.query('SELECT id,tenant_id FROM public.member_group LIMIT 0');
    console.log(JSON.stringify({ project: 'lvmzliemqnieeoruhkik', preflight: true, verifiedTLS: true, sha256 }));
    if (args.includes('--apply')) console.log(JSON.stringify({ applied: true, verification: await runMigration(client, sql) }));
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Custom fields migration failed: ${error.code || error.name}; success not confirmed.`); process.exitCode = 1; });
}

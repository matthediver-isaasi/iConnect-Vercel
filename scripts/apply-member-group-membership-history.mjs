#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const migrationUrl = new URL('../supabase/migrations/20261115_member_group_membership_history.sql', import.meta.url);
export async function runMigration(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '15s'; SET LOCAL statement_timeout = '120s'");
    await client.query(sql);
    const result = await client.query(`SELECT
      (SELECT started_at FROM member_group_history_baseline WHERE singleton) AS baseline,
      (SELECT count(*)::int FROM member_group_history_group) AS groups,
      (SELECT count(*)::int FROM member_group_membership_history) AS intervals,
      (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
        ('member_group_assignment_history','member_group_identity_history','member_group_member_delete_history')) AS triggers,
      (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace
        AND relname IN ('member_group_history_baseline','member_group_history_group','member_group_membership_history')
        AND relrowsecurity AND NOT has_table_privilege('authenticated',oid,'SELECT')
        AND NOT has_table_privilege('anon',oid,'SELECT')
        AND has_table_privilege('service_role',oid,'SELECT')
        AND NOT has_table_privilege('service_role',oid,'INSERT,UPDATE,DELETE')) AS protected_tables`);
    if (result.rows[0].triggers !== 3 || result.rows[0].protected_tables !== 3 || !result.rows[0].baseline)
      throw new Error('History verification failed');
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(a => !['--apply', '--preflight'].includes(a) && !/^--review-sha256=[a-f0-9]{64}$/.test(a)))
    throw new Error('Unsupported argument');
  const sql = await readFile(migrationUrl, 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply') && !args.includes('--preflight')) {
    console.log(JSON.stringify({ dryRun: true, sha256, migration: migrationUrl.pathname.split('/').pop() }));
    return;
  }
  if (args.includes('--apply') && !args.includes(`--review-sha256=${sha256}`))
    throw new Error('Reviewed SQL hash required');
  const target = destinationTarget(env);
  const res = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!res.ok) throw new Error('Verified TLS CA unavailable');
  const ca = await res.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid CA');
  const client = new pg.Client({ connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname } });
  try {
    await client.connect();
    const schema = await client.query(`SELECT table_name,column_name,data_type
      FROM information_schema.columns WHERE table_schema='public'
      AND table_name IN ('member','member_group','member_group_assignment')
      AND column_name IN ('id','tenant_id','name','is_active','member_id','guest_id','group_id','group_role','expires_at')
      ORDER BY table_name,column_name`);
    console.log(JSON.stringify({ project: 'lvmzliemqnieeoruhkik', database: 'postgres',
      host: target.hostname, verifiedTLS: true, sha256, sourceSchema: schema.rows }));
    if (args.includes('--apply'))
      console.log(JSON.stringify({ applied: true, verification: await runMigration(client, sql), sha256 }));
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`History migration failed: ${error.code || error.name}; no application success confirmed.`);
    process.exitCode = 1;
  });
}
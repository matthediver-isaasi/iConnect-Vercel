#!/usr/bin/env node
// Offline by default. Review the hash and obtain explicit approval before apply.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '202612310006_campaign_lifecycle.sql';
export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || new Set(args).size !== args.length
    || args.filter(arg => arg.startsWith('--review-sha256=')).length > 1) {
    throw new Error('Supported arguments: --apply --review-sha256=<sha256>');
  }
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ dryRun: true, migration: MIGRATION, sha256, writesPerformed: false }));
    return;
  }
  if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('Reviewed SHA-256 is required and must match');
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Could not load trusted destination CA');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination CA');
  const db = new pg.Client({
    connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname },
    connectionTimeoutMillis: 15000,
  });
  try {
    await db.connect();
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    // Migration is transactional standalone; retain a single transaction here
    // so verification failure rolls back all schema changes.
    await db.query(sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, ''));
    const { rows } = await db.query(`
      SELECT public.campaign_lifecycle_ready() AS ready,
        has_function_privilege('service_role','public.campaign_lifecycle(uuid,uuid,text)','EXECUTE') AS service,
        has_function_privilege('anon','public.campaign_lifecycle(uuid,uuid,text)','EXECUTE')
          OR has_function_privilege('authenticated','public.campaign_summary(uuid)','EXECUTE') AS exposed`);
    if (!rows[0]?.ready || !rows[0]?.service || rows[0]?.exposed) throw new Error('Campaign lifecycle verification failed');
    await db.query('COMMIT');
    console.log(JSON.stringify({ migration: MIGRATION, sha256, applied: true, verified: true }));
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

#!/usr/bin/env node
// Offline by default; destination-verified and hash-pinned when explicitly applied.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export async function main(args = process.argv.slice(2), env = process.env) {
  const sql = await readFile(new URL('../supabase/migrations/202612310110_zoom_confirmation_delivery.sql', import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.length) return console.log(JSON.stringify({ sha256, dryRun: true, writesPerformed: false }));
  if (args.length !== 2 || args[0] !== '--apply' || args[1] !== `--review-sha256=${sha256}`) {
    throw new Error('Use --apply with the exact reviewed migration SHA; no database was changed.');
  }
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Unable to load TLS certificate.');
  const ca = await response.text();
  const client = new pg.Client({ connectionString: target.toString(), ssl: { rejectUnauthorized: true, ca, servername: target.hostname } });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query(sql);
    await client.query('SET LOCAL ROLE service_role');
    await client.query('SELECT tenant_id,scope,resource_id,operation_id,booking_id,target,state,results,completed_at FROM public.zoom_confirmation_delivery LIMIT 0');
    await client.query('RESET ROLE');
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log('Zoom confirmation delivery migration applied and verified.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Zoom confirmation migration failed; no credentials logged.'); process.exitCode = 1; });
}

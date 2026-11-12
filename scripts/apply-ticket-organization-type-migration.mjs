#!/usr/bin/env node
// Explicit destination-only rollout; importing this module never accesses a DB.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export async function main(args = process.argv.slice(2), env = process.env) {
  const sql = await readFile(new URL('../supabase/migrations/202701210001_ticket_organization_type.sql', import.meta.url), 'utf8');
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
    const { rows } = await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='complex_event_ticket_class'
      AND column_name IN ('organization_type_enabled','organization_type_field_id','organization_type_values')`);
    if (rows.length !== 3) throw new Error('Organisation Type schema verification failed.');
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log('Organisation Type ticket migration applied and verified.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Organisation Type migration failed; no credentials logged.'); process.exitCode = 1; });
}

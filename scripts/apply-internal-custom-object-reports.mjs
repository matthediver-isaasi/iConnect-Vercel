import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
const sql = await readFile(new URL('../supabase/migrations/20261120_internal_custom_object_reports.sql', import.meta.url), 'utf8');
const hash = createHash('sha256').update(sql).digest('hex');
if (process.argv.length === 2) {
  console.log(JSON.stringify({ sha256: hash, dryRun: true }));
  process.exit(0);
}
if (process.argv.length !== 4 || process.argv[2] !== '--apply' || process.argv[3] !== `--review-sha256=${hash}`) {
  throw new Error('Use --apply with the exact reviewed migration SHA; no database was changed.');
}
const target = destinationTarget(process.env);
const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
if (!response.ok) throw new Error('Unable to load database TLS certificate');
const client = new pg.Client({ connectionString: target.toString(),
  ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
try {
  await client.connect();
  await client.query("SET lock_timeout='10s'; SET statement_timeout='60s'");
  await client.query(sql);
  console.log('Internal Custom Object report permissions migration applied.');
} catch {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Internal Custom Object report migration failed; no credentials logged.');
  process.exitCode = 1;
} finally { await client.end(); }

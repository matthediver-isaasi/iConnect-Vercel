// External Supabase only. Offline by default; never invoke from deployment/startup.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const sql = await readFile(new URL('../supabase/migrations/20261122_member_lifecycle_preparation.sql', import.meta.url), 'utf8');
const hash = createHash('sha256').update(sql).digest('hex');
const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ sha256: hash, dryRun: true, executionEnabled: false }));
} else if (args.length !== 2 || !args.includes('--apply') || !args.includes(`--review-sha256=${hash}`)) {
  console.error('Explicit approval and the exact reviewed migration SHA are required.');
  process.exitCode = 1;
} else {
  let client;
  try {
    const target = destinationTarget(process.env);
    const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
    if (!response.ok) throw new Error('TLS certificate unavailable');
    client = new pg.Client({ connectionString: target.toString(),
      ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
    await client.connect();
    await client.query("SET lock_timeout='10s'; SET statement_timeout='60s'");
    await client.query(sql);
    console.log('Lifecycle preparatory storage applied. Execution remains disabled; member records were not changed.');
  } catch {
    await client?.query('ROLLBACK').catch(() => {});
    console.error('Lifecycle preparation migration failed. No credentials logged.');
    process.exitCode = 1;
  } finally { await client?.end(); }
}

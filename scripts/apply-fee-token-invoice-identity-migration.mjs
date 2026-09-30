import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

const files = [
  'supabase/migrations/20261013_fee_token_invoice_identity.sql',
  'supabase/migrations/20261115_reminder_accounting_completion.sql',
];
const migrations = await Promise.all(files.map(async file => ({
  file, sql: await readFile(new URL(`../${file}`, import.meta.url), 'utf8'),
})));
// Bind review to both file identities, ordered execution, and exact contents.
const sha256 = createHash('sha256').update(JSON.stringify(migrations)).digest('hex');
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ dryRun: true, files, sha256, writesPerformed: false }, null, 2));
} else {
  if (!process.argv.includes(`--review-sha256=${sha256}`)) throw new Error('Reviewed migration hash required; no database changed.');
  if (!isApprovedDestinationSupabaseTarget(process.env.DEST_DATABASE_URL, process.env.DEST_SUPABASE_URL)) {
    throw new Error('Destination pin mismatch; no database changed.');
  }
  const url = new URL(process.env.DEST_DATABASE_URL);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Could not download destination CA');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination CA');
  const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true, ca, servername: url.hostname } });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    for (const migration of migrations) await client.query(migration.sql);
    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: true, files, sha256 }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { await client.end(); }
}
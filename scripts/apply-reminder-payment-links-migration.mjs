import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

const file = 'supabase/migrations/20261012_reminder_fee_token_claim.sql';
const sql = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(sql).digest('hex');
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ dryRun: true, file, sha256, writesPerformed: false,
    nextStep: 'Apply only with authorization and --apply --review-sha256=<this hash> before deploying payment-link reminders.' }, null, 2));
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
    await client.query(sql);
    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: true, file, sha256 }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { await client.end(); }
}
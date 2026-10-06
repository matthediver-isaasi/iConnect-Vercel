import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

if (!process.argv.includes('--apply')) throw new Error('Use --apply to apply the popup-only schema to pinned DEST.');
if (!isApprovedDestinationSupabaseTarget(process.env.DEST_DATABASE_URL, process.env.DEST_SUPABASE_URL)) {
  throw new Error('Destination pin mismatch; no database changed.');
}
const url = new URL(process.env.DEST_DATABASE_URL);
for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
if (!response.ok) throw new Error('Could not download destination CA');
const ca = await response.text();
const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true, ca, servername: url.hostname } });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
  await client.query(await readFile('supabase/migrations/20261006_inbox_alert_preferences.sql', 'utf8'));
  await client.query('COMMIT');
  console.log('Applied 20261006_inbox_alert_preferences.sql to pinned DEST Supabase. SOURCE unchanged.');
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Migration failed:', error.code || 'unknown', error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]'));
  process.exitCode = 1;
} finally { await client.end(); }

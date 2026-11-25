/**
 * Adds event.is_private and complex_event.is_private (Private event toggle).
 * Applies supabase/migrations/202701310001_private_event_listing.sql to DEST
 * over the IPv4 pooler (DEST_DATABASE_URL). Idempotent. Without --apply it
 * only reports whether the columns exist.
 *
 * Usage: node scripts/apply-private-event-listing.mjs [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(repoRoot, 'supabase/migrations/202701310001_private_event_listing.sql'), 'utf8');
const apply = process.argv.includes('--apply');
const connectionString = process.env.DEST_DATABASE_URL;
if (!connectionString) { console.error('DEST_DATABASE_URL must be set'); process.exit(1); }

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
const columns = async () => (await client.query(
  `SELECT table_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN ('event','complex_event') AND column_name='is_private'
    ORDER BY table_name`)).rows;
await client.connect();
try {
  console.log('Before:', await columns());
  if (apply) {
    await client.query(sql);
    console.log('Applied. After:', await columns());
  } else {
    console.log('Dry run only; pass --apply to add the columns.');
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}

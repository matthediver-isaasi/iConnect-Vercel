/**
 * Apply migration: support_ticket CSAT + auto-close columns.
 *
 * Usage:
 *   node scripts/apply-support-csat-autoclose.mjs [--apply]
 *
 * Without --apply the script prints the SQL and exits (dry-run).
 * Targets DEST_DATABASE_URL (pooler, IPv4-reachable from this workspace).
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260726_support_ticket_csat_autoclose.sql'),
  'utf8'
);

const isDryRun = !process.argv.includes('--apply');

if (isDryRun) {
  console.log('[DRY RUN] Would execute:');
  console.log(sql);
  console.log('\nPass --apply to run against DEST_DATABASE_URL.');
  process.exit(0);
}

const connectionString = process.env.DEST_DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL is not set');
  process.exit(1);
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log('Connected. Applying migration…');
  await client.query(sql);
  console.log('Done: CSAT/auto-close columns added (or already existed) on support_ticket.');
} finally {
  await client.end();
}

/**
 * Apply migration: add `area` column to support_ticket.
 *
 * Usage:
 *   node scripts/apply-support-ticket-area.mjs [--apply]
 *
 * Without --apply the script prints the SQL and exits (dry-run).
 * Targets DEST_DATABASE_URL (pooler, IPv4-reachable from this workspace).
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const { Client } = pg;

const isDryRun = !process.argv.includes('--apply');
const sql = `ALTER TABLE support_ticket ADD COLUMN IF NOT EXISTS area TEXT;`;

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
  console.log('Done: area column added (or already existed) on support_ticket.');
} finally {
  await client.end();
}

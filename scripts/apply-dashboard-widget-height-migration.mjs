/**
 * Apply the dashboard widget height migration to the destination Supabase.
 *
 * Adds a `height` column (varchar 10, NOT NULL, DEFAULT 'medium') to the
 * dashboard_widget table. All existing widgets default to 'medium', which
 * matches today's hard-coded chart sizes so nothing changes visually on deploy.
 *
 * Usage:
 *   node scripts/apply-dashboard-widget-height-migration.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATION = 'supabase/migrations/20260817_dashboard_widget_height.sql';

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('Error: DEST_DATABASE_URL (or DATABASE_URL) is not set.');
  process.exit(1);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

async function run() {
  await client.connect();
  console.log('Connected to database.');

  const sqlPath = path.join(repoRoot, MIGRATION);
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log(`Running: ${MIGRATION}`);
  await client.query(sql);
  console.log('Migration applied successfully.');

  await client.end();
}

run().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});

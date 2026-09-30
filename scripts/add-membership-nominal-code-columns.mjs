/**
 * Apply the Task 3339 membership nominal-code migration to the destination
 * Supabase (DEST_DATABASE_URL, the real prod DB — the workspace runtime
 * SUPABASE_URL points at the stale legacy SOURCE project).
 *
 * Runs supabase/migrations/20260804_membership_tier_nominal_code.sql, which
 * is idempotent, so re-running this script is safe.
 *
 * Usage: node scripts/add-membership-nominal-code-columns.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const migrationFile = path.join(repoRoot, 'supabase/migrations/20260804_membership_tier_nominal_code.sql');

const connectionString = process.env.DEST_DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL must be set');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

try {
  await client.connect();
  await client.query(fs.readFileSync(migrationFile, 'utf8'));
  const { rows } = await client.query(`
    SELECT table_name FROM information_schema.columns
    WHERE column_name = 'nominal_code'
      AND table_name IN ('membership_tier_config', 'membership_tier_band')
    ORDER BY table_name
  `);
  console.log('nominal_code present on:', rows.map((r) => r.table_name).join(', '));
} finally {
  await client.end();
}

/**
 * Apply the csv_import_job background-worker columns migration to the
 * destination Supabase over the IPv4 pooler (DEST_DATABASE_URL). Idempotent.
 *
 * Adds worker_token, heartbeat_at, started_at, completed_at, cursor_offset,
 * force_path, storage_bucket, storage_path, requested_by_member_id,
 * skipped_count, notes_created (+ a status/created_at index) so the
 * Import Manager can run imports as headless background jobs (Task #1362).
 *
 * Usage:
 *   node scripts/apply-csv-import-job-background.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SQL_FILE = 'supabase/migrations/20260614_csv_import_job_background.sql';

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

async function run() {
  const abs = path.join(repoRoot, SQL_FILE);
  if (!fs.existsSync(abs)) throw new Error(`SQL file not found: ${SQL_FILE}`);
  const sql = fs.readFileSync(abs, 'utf8');

  const client = new pg.Client({
    connectionString,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    console.log(`Applying ${SQL_FILE} ...`);
    await client.query(sql);

    const { rows } = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'csv_import_job'
         AND column_name IN (
           'worker_token', 'heartbeat_at', 'started_at', 'completed_at',
           'cursor_offset', 'force_path', 'storage_bucket', 'storage_path',
           'requested_by_member_id', 'skipped_count', 'notes_created'
         )
       ORDER BY column_name`
    );
    console.log('Present columns:', rows.map((r) => r.column_name).join(', ') || '(none)');
    console.log('Done.');
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Failed to apply migration:', err);
  process.exit(1);
});

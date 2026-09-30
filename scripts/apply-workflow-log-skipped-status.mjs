/**
 * Task 3196: relax workflow_log_status_check to allow 'skipped'.
 * Applies supabase/migrations/20260728_workflow_log_status_skipped.sql to DEST
 * over the IPv4 pooler (DEST_DATABASE_URL). Idempotent — safe to re-run.
 *
 * Usage: node scripts/apply-workflow-log-skipped-status.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(repoRoot, 'supabase/migrations/20260728_workflow_log_status_skipped.sql'), 'utf8');

const connectionString = process.env.DEST_DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL must be set');
  process.exit(1);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  const { rows } = await client.query(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='workflow_log_status_check'"
  );
  console.log('Applied. Constraint now:', rows[0]?.def);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  await client.end();
}

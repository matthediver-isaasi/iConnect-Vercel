/**
 * Apply finalized attendance workflow transitions to destination Supabase.
 * Idempotent and safe to re-run.
 *
 * Usage: node scripts/apply-attendance-transition-outbox.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const migration = 'supabase/migrations/20260830_attendance_transition_outbox.sql';
const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

try {
  await client.connect();
  await client.query('BEGIN');
  console.log(`Applying ${migration} ...`);
  await client.query(fs.readFileSync(path.join(repoRoot, migration), 'utf8'));
  await client.query('COMMIT');

  const check = await client.query(`
    SELECT
      to_regclass('attendance_outcome_transition') AS transition_table,
      to_regclass('attendance_transition_outbox') AS outbox_table,
      to_regprocedure('acknowledge_attendance_workflow_delivery(uuid,uuid,uuid,text,text)') AS recovery_rpc
  `);
  const row = check.rows[0] || {};
  if (!row.transition_table || !row.outbox_table || !row.recovery_rpc) {
    throw new Error('Attendance transition migration verification failed');
  }
  console.log('Attendance transition migration applied and verified on DEST.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
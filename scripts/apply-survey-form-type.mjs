/**
 * Task #3330: Survey form type & Score field.
 * Applies supabase/migrations/20260804_survey_form_type_score.sql to DEST
 * over the IPv4 pooler (DEST_DATABASE_URL). Idempotent — safe to re-run.
 *
 * Usage: node scripts/apply-survey-form-type.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(repoRoot, 'supabase/migrations/20260804_survey_form_type_score.sql'), 'utf8');

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
    "SELECT column_name FROM information_schema.columns WHERE table_name='form' AND column_name IN ('form_type','survey_settings','survey_audit_log') ORDER BY column_name"
  );
  const { rows: tables } = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name IN ('survey_version','survey_answer') ORDER BY table_name"
  );
  console.log('Applied. form columns:', rows.map(r => r.column_name).join(', '), '| tables:', tables.map(t => t.table_name).join(', '));
} catch (err) {
  await client.query('ROLLBACK');
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  await client.end();
}

// Apply supabase/migrations/20260806_event_budget.sql against the DEST database.
// Idempotent — safe to re-run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260806_event_budget.sql'),
  'utf8'
);

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  console.log('Migration applied: event/complex_event budget columns + event_cost_line table');
  const { rows } = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'event_cost_line' ORDER BY ordinal_position
  `);
  console.log('event_cost_line columns:', rows.map(r => r.column_name).join(', '));
} catch (err) {
  try { await client.query('ROLLBACK'); } catch {}
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  await client.end();
}

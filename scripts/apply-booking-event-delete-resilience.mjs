// Task #3344: apply supabase/migrations/20260804_booking_event_delete_resilience.sql
// against the DEST database (pooler URL). Idempotent — safe to re-run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260804_booking_event_delete_resilience.sql'),
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
  console.log('Migration applied: booking/complex_event_booking event_name column + booking_event_id_fkey ON DELETE SET NULL');

  const { rows } = await client.query(`
    SELECT rc.delete_rule FROM information_schema.referential_constraints rc
    WHERE rc.constraint_name = 'booking_event_id_fkey'
  `);
  console.log('booking_event_id_fkey delete_rule =', rows[0]?.delete_rule);
} catch (err) {
  try { await client.query('ROLLBACK'); } catch {}
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  await client.end();
}

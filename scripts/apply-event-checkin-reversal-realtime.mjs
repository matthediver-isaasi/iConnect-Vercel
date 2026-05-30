/**
 * Apply the Task #1177 check-in reversal + realtime migration.
 *
 * Adds the un-scan (deregister) audit columns to `booking` and
 * `complex_event_session_checkin`, and publishes both tables for Supabase
 * realtime so the Event Check-In dashboard updates live.
 *
 * Usage:
 *   node scripts/apply-event-checkin-reversal-realtime.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'supabase/migrations/20260530_event_checkin_reversal_realtime.sql',
];

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

async function run() {
  const files = MIGRATIONS.map((rel) => {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) throw new Error(`Migration not found: ${rel}`);
    return { rel, sql: fs.readFileSync(abs, 'utf8') };
  });
  const client = new pg.Client({
    connectionString,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const f of files) {
      console.log(`Applying ${f.rel} ...`);
      await client.query(f.sql);
    }
    await client.query('COMMIT');

    const verify = await client.query(
      `SELECT tablename FROM pg_publication_tables
       WHERE pubname='supabase_realtime'
         AND tablename IN ('booking','complex_event_session_checkin')
       ORDER BY tablename`
    );
    console.log('Published for realtime:', verify.rows.map((r) => r.tablename));
    console.log(`Done. Applied ${files.length} migration(s).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Failed to apply migration:', err);
  process.exit(1);
});

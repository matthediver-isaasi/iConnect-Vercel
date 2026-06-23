/**
 * Apply the Task #1760 count-based ticket availability capacity guard for
 * COMPLEX (multi-session) events to the destination Supabase.
 *
 * Creates/replaces the check_complex_event_ticket_capacity(...) Postgres
 * function used by the complex-event booking path to atomically guard
 * ticket-class capacity under concurrency (analogous to the standard-event
 * check_oneoff_ticket_capacity guard from Task #1758).
 *
 * Runs over the IPv4 pooler (DEST_DATABASE_URL). The migration is idempotent
 * (CREATE OR REPLACE), so re-running this script is safe.
 *
 * Usage:
 *   node scripts/apply-complex-event-ticket-capacity-guard.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'supabase/migrations/20260623_complex_event_ticket_capacity_guard.sql',
];

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

async function run() {
  const files = MIGRATIONS.map((rel) => {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`Migration file not found: ${rel}`);
    }
    return { rel, abs, sql: fs.readFileSync(abs, 'utf8') };
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
    console.log(`\nDone. Applied ${files.length} migration(s).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});

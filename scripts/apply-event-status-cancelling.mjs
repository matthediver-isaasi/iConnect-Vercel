/**
 * Allow 'cancelling' in the event/complex_event status check constraints so the
 * safe-deletion lock step (api/_lib/eventDeletion.js) no longer violates the
 * check constraint. Applies over the IPv4 pooler (DEST_DATABASE_URL). Idempotent.
 *
 * Usage:
 *   node scripts/apply-event-status-cancelling.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SQL_FILE = 'supabase/migrations/20260619_event_status_cancelling.sql';

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
      `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conname IN ('events_status_check', 'complex_event_status_check')
       ORDER BY conname`
    );
    for (const r of rows) {
      console.log(`${r.conname}:`, r.def);
    }
    console.log('Done.');
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Failed to apply migration:', err);
  process.exit(1);
});

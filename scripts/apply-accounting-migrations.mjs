/**
 * Apply the Task #999 accounting-provider migrations to the destination Supabase.
 *
 * Runs the following SQL files inside a single transaction over the IPv4
 * pooler (DEST_DATABASE_URL), in order:
 *   1. supabase/migrations/20260525_accounting_provider_phase1.sql
 *   2. supabase/migrations/20260525_backfill_accounting_provider_xero.sql
 *
 * Both files are idempotent, so re-running this script is safe.
 *
 * Usage:
 *   node scripts/apply-accounting-migrations.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'supabase/migrations/20260525_accounting_provider_phase1.sql',
  'supabase/migrations/20260525_backfill_accounting_provider_xero.sql',
  'supabase/migrations/20260525_membership_history_payment_status.sql',
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
  console.error('Failed to apply accounting migrations:', err);
  process.exit(1);
});

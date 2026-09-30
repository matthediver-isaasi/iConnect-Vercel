/**
 * Apply the GoCardless Phase 5 (renewals & existing-member migration)
 * migration to the destination Supabase.
 *
 * Runs supabase/migrations/20260729_gocardless_phase5_renewals.sql in a
 * single transaction over the IPv4 pooler (DEST_DATABASE_URL). The file is
 * idempotent, so re-running this script is safe.
 *
 * Usage:
 *   node scripts/apply-gocardless-phase5.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'supabase/migrations/20260729_gocardless_phase5_renewals.sql',
];

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

async function run() {
  const files = MIGRATIONS.map((rel) => {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) throw new Error(`Migration file not found: ${rel}`);
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
    console.log(`\nDone. Applied ${files.length} migration(s).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});

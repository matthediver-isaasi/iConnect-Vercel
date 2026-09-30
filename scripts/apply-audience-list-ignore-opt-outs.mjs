/**
 * Apply the audience_list "ignore opt-outs" migration.
 *
 * Adds an idempotent `ignore_opt_outs BOOLEAN NOT NULL DEFAULT false` column to
 * the audience_list table. When a list has this enabled, recipients resolved
 * from it bypass all opt-out suppression (global + category) for transactional
 * sends.
 *
 * Applies against the DEST (prod) database via the IPv4-reachable Supabase
 * pooler (DEST_DATABASE_URL). Do NOT point this at the SOURCE/legacy DB.
 *
 * Usage:
 *   node scripts/apply-audience-list-ignore-opt-outs.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'supabase/migrations/20260616_audience_list_ignore_opt_outs.sql',
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

    const { rows } = await client.query(
      "SELECT count(*)::int AS total, count(*) FILTER (WHERE ignore_opt_outs) ::int AS ignoring FROM audience_list"
    );
    console.log('Audience list rows:', rows[0]);
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

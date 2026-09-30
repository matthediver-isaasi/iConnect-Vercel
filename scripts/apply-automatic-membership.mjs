/**
 * Apply the automatic member-group membership migration to the destination
 * Supabase database. The migration is idempotent and runs transactionally.
 *
 * Usage:
 *   node scripts/apply-automatic-membership.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const migration = 'supabase/migrations/20260820_automatic_membership.sql';
const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

async function run() {
  const sql = fs.readFileSync(path.join(repoRoot, migration), 'utf8');
  const client = new pg.Client({
    connectionString,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    console.log(`Applying ${migration} ...`);
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Done.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error('Failed to apply migration:', error);
  process.exit(1);
});
/**
 * Apply the external portal-menu links migration to the destination database.
 *
 * Usage:
 *   node scripts/apply-portal-menu-external-links.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const migration = 'supabase/migrations/20260821_portal_menu_external_links.sql';
const connectionString = process.env.DEST_DATABASE_URL;

if (!connectionString) {
  console.error('DEST_DATABASE_URL must be set');
  process.exit(1);
}

async function run() {
  const sqlPath = path.join(repoRoot, migration);
  if (!fs.existsSync(sqlPath)) throw new Error(`Migration not found: ${migration}`);

  const client = new pg.Client({
    connectionString,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    console.log(`Applying ${migration} ...`);
    await client.query(fs.readFileSync(sqlPath, 'utf8'));
    await client.query('COMMIT');
    console.log('Done. External portal-menu fields are ready.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
/**
 * Apply the process_organization_import_batch(JSONB, UUID) SQL function to the
 * destination Supabase over the IPv4 pooler (DEST_DATABASE_URL).
 *
 * This is the organisation equivalent of apply-import-members-function.mjs and
 * powers the fast (bulk) organisation import path in api/imports/execute.js.
 * Idempotent.
 *
 * Usage:
 *   node scripts/apply-import-organizations-function.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SQL_FILE = 'supabase/functions/import_organizations.sql';

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
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.proname = 'process_organization_import_batch' AND n.nspname = 'public'
       ORDER BY args`
    );
    console.log('Installed signatures:', rows.map((r) => `(${r.args})`).join(', ') || '(none)');
    console.log('Done.');
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Failed to apply function:', err);
  process.exit(1);
});

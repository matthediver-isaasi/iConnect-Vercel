/**
 * Apply the Task #3633 per-instalment invoicing migration to the destination
 * Supabase (DEST) over the pooler connection. Idempotent — safe to re-run.
 *
 * Usage: node scripts/apply-per-instalment-invoicing.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = ['supabase/migrations/20260817_per_instalment_invoicing.sql'];

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
    console.log(`Done. Applied ${files.length} migration(s).`);
    const check = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'membership_tier_config' AND column_name = 'dd_invoicing_mode'`
    );
    const check2 = await client.query(
      `SELECT to_regclass('membership_instalment_invoices') AS t`
    );
    console.log('dd_invoicing_mode column:', check.rows.length ? 'present' : 'MISSING');
    console.log('membership_instalment_invoices table:', check2.rows[0]?.t ? 'present' : 'MISSING');
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

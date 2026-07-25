/**
 * Apply the duplicate-submission guard migration (form_submission.idempotency_key).
 *
 * Adds the nullable `idempotency_key` column + unique partial index on
 * form_submission. Runs against DEST via the pooler (DEST_DATABASE_URL) —
 * the direct host is unreachable from this workspace. Idempotent.
 *
 * Usage:
 *   node scripts/apply-form-submission-idempotency.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'supabase/migrations/20260725_form_submission_idempotency_key.sql',
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
    for (const { rel, sql } of files) {
      console.log(`Applying ${rel}...`);
      await client.query(sql);
      console.log(`Applied ${rel}`);
    }
    const { rows } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'form_submission' AND column_name = 'idempotency_key'
    `);
    console.log('Verify column present:', rows.length === 1 ? 'OK' : 'MISSING');
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

/**
 * Apply the Task #3601 organisation-group custom field values migration.
 *
 * Usage:
 *   node scripts/apply-organization-group-preference-value.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'supabase/migrations/20260816_organization_group_preference_value.sql',
  'supabase/migrations/20260816_preference_field_org_group_scope.sql',
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
    // Verify
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'organization_group_preference_value' ORDER BY ordinal_position`
    );
    console.log('organization_group_preference_value columns:', rows.map(r => r.column_name).join(', '));
    const cons = await client.query(
      `SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint
       WHERE conrelid = 'preference_field'::regclass AND contype = 'c'`
    );
    console.log('preference_field check constraints:', JSON.stringify(cons.rows));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

run().then(() => console.log('Done.')).catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

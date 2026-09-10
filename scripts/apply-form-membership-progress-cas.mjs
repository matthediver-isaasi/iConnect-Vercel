import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../supabase/migrations/20261017_form_membership_progress_cas.sql',
);
const apply = process.argv.includes('--apply');
const sql = fs.readFileSync(migrationPath, 'utf8');

if (!apply) {
  console.log(JSON.stringify({
    dryRun: true,
    migration: path.relative(process.cwd(), migrationPath),
    bytes: Buffer.byteLength(sql),
    functions: ['merge_form_membership_result', 'link_recovered_form_membership_invoice'],
  }, null, 2));
  process.exit(0);
}

if (!process.env.DEST_DATABASE_URL) {
  console.error('DEST_DATABASE_URL must be set when using --apply');
  process.exit(1);
}

const pg = await import('pg');
const client = new pg.default.Client({
  connectionString: process.env.DEST_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  console.log(`Applied ${path.basename(migrationPath)}`);
} catch (error) {
  await client.query('ROLLBACK');
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
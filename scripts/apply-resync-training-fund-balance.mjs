// Apply the training fund balance resync migration to the DEST database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

const sql = fs.readFileSync(
  path.join(repoRoot, 'supabase/migrations/20260811_resync_training_fund_balance.sql'),
  'utf8'
);

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  const { rows } = await client.query(
    "SELECT proname FROM pg_proc WHERE proname = 'resync_training_fund_balance'"
  );
  console.log('Applied. Function present:', rows.length > 0);
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Migration failed:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}

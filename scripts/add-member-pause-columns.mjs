// Apply the member membership pause migration to the destination Supabase
// over the pooler (DEST_DATABASE_URL). Idempotent — safe to re-run.
//
// Usage: node scripts/add-member-pause-columns.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const migrationFile = path.join(repoRoot, 'supabase/migrations/20260816_member_membership_pause.sql');

const connectionString = process.env.DEST_DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL must be set');
  process.exit(1);
}

const sql = fs.readFileSync(migrationFile, 'utf8');

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  await client.end();
}

// Verify via the Supabase API.
const supabase = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY);
const { error: verifyError } = await supabase
  .from('member')
  .select('membership_paused, membership_paused_at, membership_pause_restart_date, membership_paused_by, membership_pause_reason, membership_pause_gc_subscriptions')
  .limit(1);
if (verifyError) {
  console.error('Verification failed:', verifyError.message);
  process.exit(1);
}
console.log('Member pause migration applied and verified on DEST.');

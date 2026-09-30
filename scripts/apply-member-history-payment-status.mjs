/**
 * Task #3248 — Apply the payment_status / paid_at migration to the DEST
 * (production) database. `member_membership_history` on DEST was missing
 * these columns (schema drift vs organisation_membership_history), which
 * broke member-row payment reconciliation.
 *
 * Runs supabase/migrations/20260525_membership_history_payment_status.sql,
 * which is fully idempotent (ADD COLUMN IF NOT EXISTS etc.), so re-running
 * is safe.
 *
 * Usage:
 *   DEST_DATABASE_URL=postgres://... node scripts/apply-member-history-payment-status.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const MIGRATION = 'supabase/migrations/20260525_membership_history_payment_status.sql';

const connectionString = process.env.DEST_DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL must be set (this migration targets the DEST/prod DB only).');
  process.exit(1);
}

const sql = fs.readFileSync(path.join(repoRoot, MIGRATION), 'utf8');

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});
await client.connect();
try {
  console.log(`Applying ${MIGRATION} ...`);
  await client.query(sql);
  const { rows } = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_name IN ('member_membership_history', 'organisation_membership_history')
      AND column_name IN ('payment_status', 'paid_at')
    ORDER BY table_name, column_name;
  `);
  console.table(rows);
  console.log('Done.');
} finally {
  await client.end();
}

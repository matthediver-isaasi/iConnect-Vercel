/**
 * Task #1660: Apply the training_fund_purchase table + organization
 * training_fund_pending_balance column migration.
 *
 * Applies over the IPv4 pooler (DEST_DATABASE_URL). Idempotent — safe to re-run.
 *
 * Usage:
 *   node scripts/apply-training-fund-purchase.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SQL_FILE = 'supabase/migrations/20260621_training_fund_purchase.sql';

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

    const { rows: cols } = await client.query(
      `SELECT column_name, data_type, column_default
       FROM information_schema.columns
       WHERE table_name = 'training_fund_purchase'
       ORDER BY ordinal_position`
    );
    console.log('training_fund_purchase columns:');
    for (const c of cols) console.log(`  ${c.column_name} ${c.data_type}`);

    const { rows: pend } = await client.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name = 'organization' AND column_name = 'training_fund_pending_balance'`
    );
    console.log('organization.training_fund_pending_balance:', pend[0] || '(missing!)');
    console.log('Done.');
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Failed to apply migration:', err);
  process.exit(1);
});

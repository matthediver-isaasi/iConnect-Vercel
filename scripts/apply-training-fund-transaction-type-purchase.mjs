/**
 * Widen training_fund_transaction_type_check to also allow type='purchase',
 * applied to the destination Supabase over the IPv4 pooler
 * (DEST_DATABASE_URL). Idempotent; safe to re-run.
 *
 * Fixes: credit_training_fund_purchase inserted a type='purchase' ledger row
 * that the old constraint rejected, rolling back the whole credit and leaving
 * paid invoice top-ups stuck pending.
 *
 * Usage:
 *   node scripts/apply-training-fund-transaction-type-purchase.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'supabase/migrations/20260722_training_fund_transaction_type_purchase.sql',
];

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

async function run() {
  const files = MIGRATIONS.map((rel) => {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`Migration file not found: ${rel}`);
    }
    return { rel, abs, sql: fs.readFileSync(abs, 'utf8') };
  });

  const client = new pg.Client({
    connectionString,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    for (const f of files) {
      console.log(`Applying ${f.rel} ...`);
      await client.query(f.sql);
    }
    const { rows } = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conname = 'training_fund_transaction_type_check'
          AND conrelid = 'training_fund_transaction'::regclass`
    );
    console.log('Constraint now:', rows[0]?.def || '(missing)');
    console.log(`\nDone. Applied ${files.length} migration(s).`);
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Failed to apply migration:', err);
  process.exit(1);
});

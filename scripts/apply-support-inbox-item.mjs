/**
 * Apply the support_inbox_item table migration to the destination Supabase
 * over the IPv4 pooler (DEST_DATABASE_URL). Idempotent.
 *
 * Creates support_inbox_item (per-recipient, per-event support ticket
 * notification rows) plus its three indexes so the GET /api/support/inbox
 * endpoint and the Support Management page work.
 *
 * Usage:
 *   node scripts/apply-support-inbox-item.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SQL_FILE = 'supabase/migrations/20260629_support_inbox_item.sql';

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
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'support_inbox_item'
       ORDER BY ordinal_position`
    );
    console.log('Columns:', cols.map((r) => r.column_name).join(', ') || '(none)');

    const { rows: idx } = await client.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE tablename = 'support_inbox_item'
       ORDER BY indexname`
    );
    console.log('Indexes:', idx.map((r) => r.indexname).join(', ') || '(none)');
    console.log('Done.');
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Failed to apply migration:', err);
  process.exit(1);
});

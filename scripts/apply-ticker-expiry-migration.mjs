/**
 * Apply the news ticker expiry date migration.
 *
 * Usage:
 *   node scripts/apply-ticker-expiry-migration.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'migrations/add_ticker_expiry_date_to_news_post.sql',
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
    const check = await client.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'news_post' AND column_name = 'ticker_expiry_date'"
    );
    console.log('Verify:', check.rows);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

run().then(() => console.log('Done')).catch((err) => {
  console.error(err);
  process.exit(1);
});

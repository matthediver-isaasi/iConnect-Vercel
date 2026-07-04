/**
 * Apply the Help Center migration (Task #2199) to the destination Supabase over
 * the IPv4 pooler (DEST_DATABASE_URL).
 *
 * Creates the help_article table + indexes. Idempotent; safe to re-run.
 *
 * Usage:
 *   node scripts/apply-help-articles.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'supabase/migrations/20260704_help_article.sql',
  'supabase/migrations/20260704_help_article_required_feature.sql',
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
    console.log(`\nDone. Applied ${files.length} migration(s).`);
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Failed to apply migration:', err);
  process.exit(1);
});

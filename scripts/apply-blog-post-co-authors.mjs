/**
 * Apply the Blog Co-Authors (Task #1222) migration to the destination Supabase
 * over the IPv4 pooler (DEST_DATABASE_URL). Idempotent; safe to re-run.
 *
 * Creates the blog_post_author join table and backfills one author-link row for
 * every existing post from its current primary author.
 *
 * Usage:
 *   node scripts/apply-blog-post-co-authors.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'supabase/migrations/20260603_blog_post_co_authors.sql',
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
      'SELECT COUNT(*)::int AS links, COUNT(DISTINCT blog_post_id)::int AS posts FROM blog_post_author'
    );
    console.log(`\nDone. blog_post_author now has ${rows[0].links} link row(s) across ${rows[0].posts} post(s).`);
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Failed to apply migration:', err);
  process.exit(1);
});

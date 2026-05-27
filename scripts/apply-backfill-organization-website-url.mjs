/**
 * Apply the "backfill organization.website_url from organization.website"
 * migration to destination Supabase over the IPv4 pooler (DEST_DATABASE_URL).
 *
 * Idempotent; safe to re-run.
 *
 * Usage:
 *   node scripts/apply-backfill-organization-website-url.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'supabase/migrations/20260527_backfill_organization_website_url.sql',
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
    // Report what we're about to touch, then apply.
    const { rows: pre } = await client.query(
      `SELECT COUNT(*)::int AS to_backfill
       FROM organization
       WHERE (website_url IS NULL OR website_url = '')
         AND website IS NOT NULL
         AND website <> ''`
    );
    console.log(`Rows to backfill: ${pre[0].to_backfill}`);

    for (const f of files) {
      console.log(`Applying ${f.rel} ...`);
      await client.query(f.sql);
    }

    const { rows: post } = await client.query(
      `SELECT COUNT(*)::int AS remaining
       FROM organization
       WHERE (website_url IS NULL OR website_url = '')
         AND website IS NOT NULL
         AND website <> ''`
    );
    console.log(`Rows still needing backfill (should be 0): ${post[0].remaining}`);
    console.log(`\nDone. Applied ${files.length} migration(s).`);
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Failed to apply migration:', err);
  process.exit(1);
});

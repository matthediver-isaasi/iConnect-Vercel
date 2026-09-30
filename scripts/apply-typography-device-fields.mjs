/**
 * Apply the typography per-device (mobile + tablet) column migrations.
 *
 * Fixes published Canvas Hero/typography rendering: the destination database
 * was missing the per-device typography columns that both the SSR layer
 * (api/_lib/renderHtml.js) and the public endpoint
 * (api/public/typography-styles.js) SELECT, so those queries failed and the
 * published pages fell back to small default font sizes.
 *
 * Applies, in order:
 *   1. 20260520_typography_style_mobile_fields.sql
 *   2. 20260521_typography_style_tablet_fields.sql
 *
 * Both migrations are idempotent (ADD COLUMN IF NOT EXISTS) and issue
 * NOTIFY pgrst, 'reload schema', so re-running is safe.
 *
 * Usage:
 *   node scripts/apply-typography-device-fields.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'supabase/migrations/20260520_typography_style_mobile_fields.sql',
  'supabase/migrations/20260521_typography_style_tablet_fields.sql',
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
    console.log(`Done. Applied ${files.length} migration(s).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Failed to apply migration:', err);
  process.exit(1);
});

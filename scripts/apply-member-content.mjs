/**
 * Inspect or apply the original Member AI Knowledge Assistant migration.
 *
 * This is intentionally a DEST-only recovery script. The current production
 * member-content table uses generation-aware publication, so replaying the
 * original migration there is unsafe. The default is read-only; pass
 * --apply explicitly only when the destination is confirmed to be legacy.
 *
 * Usage:
 *   node scripts/apply-member-content.mjs          # dry-run (default)
 *   node scripts/apply-member-content.mjs --apply  # apply to DEST
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APPLY = process.argv.slice(2).includes('--apply');
const MIGRATIONS = ['supabase/migrations/20260706_member_content_chunk.sql'];
const MEMBER_CONTENT_SCHEMA_MISMATCH = 'MEMBER_CONTENT_SCHEMA_MISMATCH';

async function hasGenerationColumn(client) {
  const result = await client.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'member_content_chunk'
      AND column_name = 'source_generation'
    LIMIT 1
  `);
  return result.rows.length > 0;
}

async function run() {
  const files = MIGRATIONS.map((rel) => {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) throw new Error(`Migration file not found: ${rel}`);
    return { rel, sql: fs.readFileSync(abs, 'utf8') };
  });

  // connectDestination rejects SOURCE/generic URLs and installs the verified
  // Supabase CA with rejectUnauthorized=true.
  const client = await connectDestination();
  try {
    await client.query(APPLY ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    if (APPLY) {
      const { rows } = await client.query(
        "SELECT to_regclass('public.member_content_chunk') IS NOT NULL AS exists"
      );
      // Serialize the capability check with any schema evolution, not just
      // this runner. Do not let the legacy DDL race a generation migration.
      if (rows[0].exists) {
        await client.query('LOCK TABLE public.member_content_chunk IN ACCESS EXCLUSIVE MODE');
      }
    }
    const generationSchema = await hasGenerationColumn(client);
    if (generationSchema) {
      const message =
        `${MEMBER_CONTENT_SCHEMA_MISMATCH}: DEST member_content_chunk.source_generation ` +
        'exists; refusing to replay the original legacy migration';
      if (APPLY) throw new Error(message);
      console.log(`DRY-RUN blocked: ${message}`);
      return;
    }

    if (!APPLY) {
      console.log(
        `DRY-RUN: DEST has no member_content_chunk.source_generation; ` +
          `would apply ${files.length} migration(s): ${files.map((f) => f.rel).join(', ')}`
      );
      return;
    }

    for (const f of files) {
      console.log(`Applying ${f.rel} to DEST ...`);
      await client.query(f.sql);
    }
    await client.query('COMMIT');
    console.log(`\nDone. Applied ${files.length} migration(s) to DEST.`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

run().catch((err) => {
  console.error('Failed to inspect/apply member-content migration:', {
    code: err.code || 'migration_blocked',
    message: err.message?.startsWith(MEMBER_CONTENT_SCHEMA_MISMATCH)
      ? err.message
      : 'Check destination connectivity, permissions and schema before retrying.',
  });
  process.exit(1);
});

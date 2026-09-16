/**
 * Inspect or apply the focused member-content repair migration.
 *
 * This runner is destination-only and defaults to a read-only plan.  It does
 * not replay the original full member-content migration.  Applying is an
 * explicit, single transaction with short DDL/query timeouts.
 *
 * Usage:
 *   node scripts/apply-member-content-repair.mjs
 *   node scripts/apply-member-content-repair.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APPLY = process.argv.slice(2).includes('--apply');
const REPAIR_DIR = path.join(repoRoot, 'scripts', 'sql', 'member-content-repair');
const MANIFEST_PATH = path.join(REPAIR_DIR, 'manifest.json');

function loadMigrationManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Repair SQL manifest not found: ${path.relative(repoRoot, MANIFEST_PATH)}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`Repair SQL manifest is not valid JSON: ${error.message}`);
  }
  if (manifest.productionOnly !== true || manifest.ordered !== true) {
    throw new Error('Repair SQL manifest must be marked productionOnly and ordered');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Repair SQL manifest must contain a non-empty files array');
  }
  const uniqueFiles = new Set(manifest.files);
  if (uniqueFiles.size !== manifest.files.length) {
    throw new Error('Repair SQL manifest contains duplicate files');
  }
  const lexicalFiles = [...manifest.files].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(lexicalFiles) !== JSON.stringify(manifest.files)) {
    throw new Error('Repair SQL manifest must list files in lexical order');
  }
  return manifest.files.map((file) => {
    if (
      typeof file !== 'string' ||
      path.isAbsolute(file) ||
      file.includes('/') ||
      file.includes('\\') ||
      !file.endsWith('.sql')
    ) {
      throw new Error(`Invalid repair SQL manifest entry: ${String(file)}`);
    }
    const absolute = path.join(REPAIR_DIR, file);
    if (!fs.existsSync(absolute)) throw new Error(`Repair SQL file not found: ${file}`);
    return {
      migration: path.relative(repoRoot, absolute),
      sql: fs.readFileSync(absolute, 'utf8'),
    };
  });
}

async function inspect(client, migrations) {
  const { rows: tableRows } = await client.query(`
    SELECT
      to_regclass('public.member_content_source') IS NOT NULL AS source_exists,
      to_regclass('public.member_content_chunk') IS NOT NULL AS chunk_exists
  `);
  const { rows: indexes } = await client.query(`
    SELECT
      c.relname AS index_name,
      i.indisunique AS is_unique,
      i.indisvalid AS is_valid,
      i.indisready AS is_ready,
      i.indimmediate AS is_immediate,
      i.indpred IS NULL AS is_nonpartial,
      i.indexprs IS NULL AS is_expression_free,
      pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index AS i
    JOIN pg_class AS c ON c.oid = i.indexrelid
    WHERE i.indrelid = to_regclass('public.member_content_chunk')
      AND c.relname IN (
        'member_content_chunk_generation_idx',
        'member_content_chunk_source_idx'
      )
    ORDER BY c.relname
  `);
  console.log(
    JSON.stringify({
      mode: 'DRY-RUN',
      destination: true,
      source_exists: tableRows[0]?.source_exists ?? false,
      chunk_exists: tableRows[0]?.chunk_exists ?? false,
      relevant_indexes: indexes,
      would_apply: migrations.map(({ migration }) => migration),
    }, null, 2)
  );
  console.log(
    '\nDRY-RUN only: no DDL or production data mutation was performed. ' +
    'Pass --apply only after reviewing the destination checks.'
  );
}

async function run() {
  const migrations = loadMigrationManifest();
  // connectDestination rejects SOURCE/generic URLs and pins the published
  // Supabase CA with rejectUnauthorized=true.
  const client = await connectDestination();
  try {
    if (!APPLY) {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '30s'");
      await inspect(client, migrations);
      await client.query('COMMIT');
      return;
    }

    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    for (const migration of migrations) {
      await client.query(migration.sql);
    }
    await client.query('COMMIT');
    console.log(
      `Applied focused destination repair SQL: ${
        migrations.map(({ migration }) => migration).join(', ')
      }`,
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

run().catch((error) => {
  console.error('Member-content repair migration failed:', {
    code: error.code || 'repair_migration_failed',
    message: error.message || String(error),
  });
  process.exit(1);
});
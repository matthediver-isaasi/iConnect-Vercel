/**
 * Unified back-of-card ordering for directory cards.
 *
 * Adds back_field_order (jsonb array of core keys and "custom:<id>" entries)
 * to dynamic_directory so each directory can override the tenant-wide default
 * back-of-card field order. NULL means "use tenant default". Idempotent.
 *
 * Runs over the IPv4 pooler (DEST_DATABASE_URL — the production data target).
 * Usage: node scripts/apply-directory-back-order-migration.mjs
 */
import pg from 'pg';

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query(`ALTER TABLE dynamic_directory ADD COLUMN IF NOT EXISTS back_field_order JSONB DEFAULT NULL`);
  await client.query(`COMMENT ON COLUMN dynamic_directory.back_field_order IS 'Per-directory override for back-of-card field order: array of core field keys and custom:<field_id> entries. NULL = use tenant default.'`);
  console.log('dynamic_directory.back_field_order ensured on DEST.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}

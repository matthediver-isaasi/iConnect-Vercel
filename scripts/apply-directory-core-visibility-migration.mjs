/**
 * Per-directory core-field visibility for dynamic directories.
 *
 * Adds core_field_visibility (jsonb map of core field key ->
 * { front?, back? } overrides) to dynamic_directory. Absent key/side means
 * "inherit the tenant-global directory display settings". NULL = inherit all.
 *
 * Runs over the IPv4 pooler (DEST_DATABASE_URL — the production data target).
 * Usage: node scripts/apply-directory-core-visibility-migration.mjs
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
  await client.query(`ALTER TABLE dynamic_directory ADD COLUMN IF NOT EXISTS core_field_visibility JSONB DEFAULT NULL`);
  await client.query(`COMMENT ON COLUMN dynamic_directory.core_field_visibility IS 'Per-directory core field visibility overrides: { "<core key>": { "front": bool, "back": bool } }. Missing key/side inherits the tenant-global directory display settings. NULL = inherit everything.'`);
  console.log('dynamic_directory.core_field_visibility ensured on DEST.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}

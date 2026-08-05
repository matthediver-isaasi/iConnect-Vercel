/**
 * Per-directory "Additional Information" label override for dynamic directories.
 *
 * Adds custom_fields_label (text) to dynamic_directory. NULL/blank means
 * "inherit the tenant-global directory label" (member_directory_display
 * custom_fields_label or org_directory_custom_fields_label), which itself
 * falls back to the default "Additional Information".
 *
 * Runs over the IPv4 pooler (DEST_DATABASE_URL — the production data target).
 * Usage: node scripts/apply-directory-custom-fields-label-migration.mjs
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
  await client.query(`ALTER TABLE dynamic_directory ADD COLUMN IF NOT EXISTS custom_fields_label TEXT DEFAULT NULL`);
  await client.query(`COMMENT ON COLUMN dynamic_directory.custom_fields_label IS 'Per-directory override for the back-of-card custom-fields section heading. NULL/blank inherits the tenant-global label, then the default "Additional Information".'`);
  console.log('dynamic_directory.custom_fields_label ensured on DEST.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}

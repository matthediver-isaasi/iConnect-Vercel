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
  await client.query(`ALTER TABLE dynamic_directory ADD COLUMN IF NOT EXISTS view_members_role_ids JSONB DEFAULT NULL`);
  await client.query(`COMMENT ON COLUMN dynamic_directory.view_members_role_ids IS 'Role IDs eligible for View Members in this organisation directory. NULL inherits the tenant setting; [] explicitly shows no members.'`);
  await client.query(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY id) AS position
      FROM system_settings
      WHERE setting_key = 'org_directory_view_members_role_ids'
    )
    DELETE FROM system_settings
    WHERE id IN (SELECT id FROM ranked WHERE position > 1)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS system_settings_org_view_members_one_per_tenant
    ON system_settings (tenant_id)
    WHERE setting_key = 'org_directory_view_members_role_ids'
  `);
  await client.query(`
    INSERT INTO system_settings (tenant_id, setting_key, setting_value, description)
    SELECT legacy.tenant_id, 'org_directory_view_members_role_ids', MAX(legacy.setting_value),
           'Role IDs eligible for organisation directory View Members pages'
    FROM system_settings legacy
    WHERE legacy.setting_key = 'org_directory_reverse_card_role_ids'
      AND NOT EXISTS (
        SELECT 1 FROM system_settings current_setting
        WHERE current_setting.tenant_id = legacy.tenant_id
          AND current_setting.setting_key = 'org_directory_view_members_role_ids'
      )
    GROUP BY legacy.tenant_id
    ON CONFLICT (tenant_id)
    WHERE setting_key = 'org_directory_view_members_role_ids'
    DO NOTHING
  `);
  console.log('Organisation View Members role policy ensured on DEST.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
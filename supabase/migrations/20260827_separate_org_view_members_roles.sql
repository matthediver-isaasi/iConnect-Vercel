-- Separate organisation-card contacts from the directory-owned View Members list.
ALTER TABLE dynamic_directory
ADD COLUMN IF NOT EXISTS view_members_role_ids JSONB DEFAULT NULL;

COMMENT ON COLUMN dynamic_directory.view_members_role_ids IS
  'Role IDs eligible for View Members in this organisation directory. NULL inherits the tenant setting; [] explicitly shows no members.';

-- Keep this disclosure policy singular without changing uniqueness rules for
-- unrelated legacy settings. If a partially applied rollout created duplicate
-- rows, retain the deterministic lowest-id row before creating the index.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY id) AS position
  FROM system_settings
  WHERE setting_key = 'org_directory_view_members_role_ids'
)
DELETE FROM system_settings
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

CREATE UNIQUE INDEX IF NOT EXISTS
  system_settings_org_view_members_one_per_tenant
ON system_settings (tenant_id)
WHERE setting_key = 'org_directory_view_members_role_ids';

-- Preserve existing behaviour once, without coupling later edits.
INSERT INTO system_settings (tenant_id, setting_key, setting_value, description)
SELECT legacy.tenant_id,
       'org_directory_view_members_role_ids',
       MAX(legacy.setting_value),
       'Role IDs eligible for organisation directory View Members pages'
FROM system_settings legacy
WHERE legacy.setting_key = 'org_directory_reverse_card_role_ids'
  AND NOT EXISTS (
    SELECT 1
    FROM system_settings current_setting
    WHERE current_setting.tenant_id = legacy.tenant_id
      AND current_setting.setting_key = 'org_directory_view_members_role_ids'
  )
GROUP BY legacy.tenant_id
ON CONFLICT (tenant_id)
WHERE setting_key = 'org_directory_view_members_role_ids'
DO NOTHING;
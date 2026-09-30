-- Personal relationship-panel preferences remain in system_settings for
-- backwards-compatible settings storage, but are owned and addressed only by
-- the server-authenticated actor.
--
-- Keep one row per tenant/actor/relationship-side. The dedicated API retries a
-- concurrent first insert as an update when this constraint reports 23505.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, setting_key
           ORDER BY id
         ) AS position
  FROM system_settings
  WHERE setting_key LIKE 'relationship_columns_%'
)
DELETE FROM system_settings
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

CREATE UNIQUE INDEX IF NOT EXISTS
  system_settings_relationship_columns_one_per_actor_panel
ON system_settings (tenant_id, setting_key)
WHERE setting_key LIKE 'relationship_columns_%';

NOTIFY pgrst, 'reload schema';
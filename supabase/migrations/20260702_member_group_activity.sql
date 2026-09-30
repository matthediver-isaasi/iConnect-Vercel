-- Member group join/leave activity log.
--
-- Provides a durable, tenant-scoped record of when a member joined or left a
-- member group. The group name is snapshotted at write time so it survives
-- group renames and deletion.
--
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS member_group_activity (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  member_id     uuid        NOT NULL,
  group_id      uuid,
  group_name    text        NOT NULL,
  action        text        NOT NULL CHECK (action IN ('joined', 'left')),
  actor_email   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'member_group_activity'
      AND indexname  = 'idx_member_group_activity_member'
  ) THEN
    CREATE INDEX idx_member_group_activity_member
      ON member_group_activity (tenant_id, member_id, created_at DESC);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'member_group_activity'
      AND indexname  = 'idx_member_group_activity_group'
  ) THEN
    CREATE INDEX idx_member_group_activity_group
      ON member_group_activity (group_id, created_at DESC);
  END IF;
END $$;

-- Automatic Membership
--
-- 1. Add automatic-membership fields to member_group (group-level config)
-- 2. Add assignment_source to member_group_assignment
-- 3. Add automatic_membership_generation with a trigger to increment it
-- 4. Create SECURITY DEFINER RPC: reconcile_automatic_membership
--
-- Idempotent: safe to re-run.

-- ============================================================
-- 1. member_group: automatic membership config fields
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.member_group') IS NULL THEN
    RAISE NOTICE 'member_group does not exist; skipping.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'member_group'
      AND column_name = 'automatic_membership_enabled'
  ) THEN
    ALTER TABLE member_group
      ADD COLUMN automatic_membership_enabled boolean NOT NULL DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'member_group'
      AND column_name = 'automatic_membership_role'
  ) THEN
    ALTER TABLE member_group
      ADD COLUMN automatic_membership_role text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'member_group'
      AND column_name = 'automatic_membership_filter_groups'
  ) THEN
    ALTER TABLE member_group
      ADD COLUMN automatic_membership_filter_groups jsonb NOT NULL DEFAULT '[]'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'member_group'
      AND column_name = 'allow_members_to_leave'
  ) THEN
    ALTER TABLE member_group
      ADD COLUMN allow_members_to_leave boolean NOT NULL DEFAULT true;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'member_group'
      AND column_name = 'automatic_membership_sync_status'
  ) THEN
    ALTER TABLE member_group
      ADD COLUMN automatic_membership_sync_status text NOT NULL DEFAULT 'idle';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'member_group'
      AND column_name = 'automatic_membership_last_synced_at'
  ) THEN
    ALTER TABLE member_group
      ADD COLUMN automatic_membership_last_synced_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'member_group'
      AND column_name = 'automatic_membership_match_count'
  ) THEN
    ALTER TABLE member_group
      ADD COLUMN automatic_membership_match_count integer;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'member_group'
      AND column_name = 'automatic_membership_sync_error'
  ) THEN
    ALTER TABLE member_group
      ADD COLUMN automatic_membership_sync_error text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'member_group'
      AND column_name = 'automatic_membership_cursor'
  ) THEN
    ALTER TABLE member_group
      ADD COLUMN automatic_membership_cursor text;
  END IF;

  -- Generation counter for stale-worker fencing.
  -- Incremented automatically by trigger whenever enabled/role/filter_groups changes.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'member_group'
      AND column_name = 'automatic_membership_generation'
  ) THEN
    ALTER TABLE member_group
      ADD COLUMN automatic_membership_generation bigint NOT NULL DEFAULT 0;
  END IF;
END $$;

-- ============================================================
-- 2. member_group_assignment: assignment_source
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.member_group_assignment') IS NULL THEN
    RAISE NOTICE 'member_group_assignment does not exist; skipping.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'member_group_assignment'
      AND column_name = 'assignment_source'
  ) THEN
    ALTER TABLE member_group_assignment
      ADD COLUMN assignment_source text NOT NULL DEFAULT 'manual';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'member_group_assignment'
      AND constraint_name = 'chk_member_group_assignment_source'
  ) THEN
    ALTER TABLE member_group_assignment
      ADD CONSTRAINT chk_member_group_assignment_source
      CHECK (assignment_source IN ('manual', 'self_join', 'automatic'));
  END IF;
END $$;

-- ============================================================
-- 3. Trigger: increment generation + reset sync fields whenever
--    automatic membership config changes.
-- ============================================================
CREATE OR REPLACE FUNCTION trg_member_group_auto_membership_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only fire when a relevant config column actually changes
  IF (
    NEW.automatic_membership_enabled    IS DISTINCT FROM OLD.automatic_membership_enabled    OR
    NEW.automatic_membership_role       IS DISTINCT FROM OLD.automatic_membership_role       OR
    NEW.automatic_membership_filter_groups IS DISTINCT FROM OLD.automatic_membership_filter_groups
  ) THEN
    NEW.automatic_membership_generation := OLD.automatic_membership_generation + 1;

    -- Re-queue when enabled; mark idle when disabled
    IF NEW.automatic_membership_enabled THEN
      NEW.automatic_membership_sync_status  := 'queued';
      NEW.automatic_membership_cursor       := NULL;
      NEW.automatic_membership_sync_error   := NULL;
    ELSE
      NEW.automatic_membership_sync_status  := 'idle';
      NEW.automatic_membership_cursor       := NULL;
      NEW.automatic_membership_sync_error   := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Drop existing trigger before recreating (idempotent)
DROP TRIGGER IF EXISTS trg_auto_membership_generation ON member_group;

CREATE TRIGGER trg_auto_membership_generation
  BEFORE UPDATE ON member_group
  FOR EACH ROW
  EXECUTE FUNCTION trg_member_group_auto_membership_generation();

-- ============================================================
-- 4. SECURITY DEFINER RPC: reconcile_automatic_membership
--
-- Atomically reconciles automatic assignments for one batch of a group sync.
--
-- Parameters:
--   p_group_id            - group being reconciled
--   p_tenant_id           - tenant ownership check
--   p_role                - role to assign on insert
--   p_batch_member_ids    - member IDs to INSERT in this batch (sorted slice)
--   p_full_target_ids     - COMPLETE sorted target set (all pages combined)
--   p_is_final_batch      - true on the last batch; triggers stale deletes
--   p_next_cursor         - cursor for the caller to store (null = done)
--   p_full_match_count    - total matched members (stored when is_final_batch)
--   p_expected_generation - generation value the caller read; rejects if group
--                           has since been mutated (stale-worker fencing)
--   p_expected_cursor     - cursor value the caller read; rejects if another
--                           concurrent worker has already advanced past this point
--
-- Behaviour:
--   - SELECT group row FOR UPDATE (serialises concurrent workers).
--   - Verifies enabled=true, generation=p_expected_generation,
--     role matches p_role, cursor IS NOT DISTINCT FROM p_expected_cursor.
--   - Rejects with structured error codes on mismatch.
--   - INSERT members in p_batch_member_ids not yet assigned (any source).
--   - UPDATE group_role on existing automatic-source rows for members in
--     p_full_target_ids (role sync without re-inserting or touching manual rows).
--   - DELETE only on p_is_final_batch=true: removes automatic-source rows
--     whose member_id is NOT in p_full_target_ids AND whose member belongs
--     to the tenant (p_tenant_id guard).
--   - Writes member_group_activity only when mutations actually happen.
--   - Updates sync status on member_group.
--   - All member inserts and deletes are guarded by member.tenant_id=p_tenant_id
--     to prevent foreign members from being operated on.
--   - Revokes PUBLIC; grants only service_role.
-- ============================================================
DROP FUNCTION IF EXISTS reconcile_automatic_membership(UUID, UUID, TEXT, UUID[], TEXT);
DROP FUNCTION IF EXISTS reconcile_automatic_membership(UUID, UUID, TEXT, UUID[], UUID[], BOOLEAN, TEXT, INTEGER);
DROP FUNCTION IF EXISTS reconcile_automatic_membership(UUID, UUID, TEXT, UUID[], UUID[], BOOLEAN, TEXT, INTEGER, BIGINT, TEXT);

CREATE OR REPLACE FUNCTION reconcile_automatic_membership(
  p_group_id            UUID,
  p_tenant_id           UUID,
  p_role                TEXT,
  p_batch_member_ids    UUID[],
  p_full_target_ids     UUID[],
  p_is_final_batch      BOOLEAN DEFAULT true,
  p_next_cursor         TEXT DEFAULT NULL,
  p_full_match_count    INTEGER DEFAULT NULL,
  p_expected_generation BIGINT DEFAULT NULL,
  p_expected_cursor     TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_name    TEXT;
  v_group_enabled BOOLEAN;
  v_group_role    TEXT;
  v_group_gen     BIGINT;
  v_group_cursor  TEXT;
  v_inserted      INT := 0;
  v_deleted       INT := 0;
  v_role_updated  INT := 0;
  v_mid           UUID;
  v_aid           UUID;
  v_now           TIMESTAMPTZ := now();
  v_existing_ids  UUID[];
  v_valid_target_ids UUID[];
  v_valid_batch_ids UUID[];
  v_to_insert     UUID[];
  v_del_ids       UUID[];
  v_del_member_id UUID;
BEGIN
  -- Lock the group row for the duration of this transaction.
  -- This serialises concurrent workers on the same group.
  SELECT name, automatic_membership_enabled, automatic_membership_role,
         automatic_membership_generation, automatic_membership_cursor
    INTO v_group_name, v_group_enabled, v_group_role, v_group_gen, v_group_cursor
    FROM member_group
   WHERE id = p_group_id
     AND tenant_id = p_tenant_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'GROUP_NOT_FOUND',
      'detail', 'Group not found or does not belong to tenant'
    );
  END IF;

  -- Verify automatic membership is still enabled
  IF NOT v_group_enabled THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'NOT_ENABLED',
      'detail', 'Automatic membership is no longer enabled for this group'
    );
  END IF;

  -- Stale-generation fencing: a generation is mandatory and must still match.
  IF p_expected_generation IS NULL OR v_group_gen <> p_expected_generation THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'STALE_GENERATION',
      'detail', format(
        'Group config changed (expected generation %s, current %s). Restart reconciliation.',
        p_expected_generation, v_group_gen
      )
    );
  END IF;

  -- Role mismatch: caller must pass the role they loaded; reject if it changed
  IF v_group_role IS DISTINCT FROM p_role THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'STALE_GENERATION',
      'detail', format(
        'Group role changed (expected "%s", current "%s"). Restart reconciliation.',
        p_role, v_group_role
      )
    );
  END IF;

  -- Cursor fencing: reject if a concurrent worker already advanced the cursor
  IF v_group_cursor IS DISTINCT FROM p_expected_cursor THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'CURSOR_MISMATCH',
      'detail', format(
        'Cursor mismatch (expected %s, current %s). Another worker may have advanced.',
        COALESCE(p_expected_cursor, 'NULL'), COALESCE(v_group_cursor, 'NULL')
      )
    );
  END IF;

  -- Re-derive both supplied ID arrays from tenant-owned member rows. This is
  -- the final trust boundary for the SECURITY DEFINER function.
  SELECT COALESCE(array_agg(id ORDER BY id), '{}'::uuid[])
    INTO v_valid_target_ids
    FROM member
   WHERE tenant_id = p_tenant_id
     AND id = ANY(COALESCE(p_full_target_ids, '{}'::uuid[]));

  SELECT COALESCE(array_agg(id ORDER BY id), '{}'::uuid[])
    INTO v_valid_batch_ids
    FROM member
   WHERE tenant_id = p_tenant_id
     AND id = ANY(COALESCE(p_batch_member_ids, '{}'::uuid[]));

  -- --------------------------------------------------------
  -- Existing member_ids in this group (any source)
  -- --------------------------------------------------------
  SELECT ARRAY(
    SELECT member_id
      FROM member_group_assignment
     WHERE group_id = p_group_id
       AND member_id IS NOT NULL
  ) INTO v_existing_ids;

  -- --------------------------------------------------------
  -- INSERT: batch members not yet in the group
  --         Only insert members that belong to this tenant.
  -- --------------------------------------------------------
  SELECT ARRAY(
    SELECT unnest(v_valid_batch_ids)
    EXCEPT
    SELECT unnest(COALESCE(v_existing_ids, '{}'))
  ) INTO v_to_insert;

  FOREACH v_mid IN ARRAY COALESCE(v_to_insert, '{}') LOOP
    INSERT INTO member_group_assignment (
      group_id, member_id, group_role, assignment_source, tenant_id
    )
    VALUES (
      p_group_id, v_mid, p_role, 'automatic', p_tenant_id
    )
    ON CONFLICT DO NOTHING;

    IF FOUND THEN
      v_inserted := v_inserted + 1;
      INSERT INTO member_group_activity (
        tenant_id, member_id, group_id, group_name, action, actor_email
      ) VALUES (
        p_tenant_id, v_mid, p_group_id, v_group_name, 'joined', 'automatic-membership'
      );
    END IF;
  END LOOP;

  -- --------------------------------------------------------
  -- ROLE UPDATE: sync group_role on existing automatic-source
  -- rows for members who are in the full target set.
  -- Manual / self_join rows are never touched.
  -- --------------------------------------------------------
  UPDATE member_group_assignment
     SET group_role = p_role
   WHERE group_id = p_group_id
     AND assignment_source = 'automatic'
     AND group_role IS DISTINCT FROM p_role
     AND member_id = ANY(v_valid_target_ids)
     AND EXISTS (
       SELECT 1 FROM member m
        WHERE m.id = member_group_assignment.member_id
          AND m.tenant_id = p_tenant_id
     );
  GET DIAGNOSTICS v_role_updated = ROW_COUNT;

  -- --------------------------------------------------------
  -- DELETE stale automatic rows — only on the final batch.
  -- Guard: member must belong to p_tenant_id.
  -- --------------------------------------------------------
  IF p_is_final_batch THEN
    SELECT ARRAY(
      SELECT mga.id
        FROM member_group_assignment mga
        JOIN member m ON m.id = mga.member_id AND m.tenant_id = p_tenant_id
       WHERE mga.group_id = p_group_id
         AND mga.assignment_source = 'automatic'
         AND mga.member_id IS NOT NULL
         AND mga.member_id <> ALL(v_valid_target_ids)
    ) INTO v_del_ids;

    FOREACH v_aid IN ARRAY COALESCE(v_del_ids, '{}') LOOP
      DELETE FROM member_group_assignment
       WHERE id = v_aid
         AND assignment_source = 'automatic'
      RETURNING member_id INTO v_del_member_id;

      IF v_del_member_id IS NOT NULL THEN
        INSERT INTO member_group_activity (
          tenant_id, member_id, group_id, group_name, action, actor_email
        ) VALUES (
          p_tenant_id, v_del_member_id, p_group_id, v_group_name, 'left', 'automatic-membership'
        );
        v_deleted := v_deleted + 1;
      END IF;
    END LOOP;
  END IF;

  -- --------------------------------------------------------
  -- Update sync status on member_group
  -- --------------------------------------------------------
  UPDATE member_group
     SET automatic_membership_sync_status   = CASE WHEN p_is_final_batch THEN 'idle' ELSE 'running' END,
         automatic_membership_last_synced_at = CASE WHEN p_is_final_batch THEN v_now ELSE automatic_membership_last_synced_at END,
          automatic_membership_match_count    = CASE WHEN p_is_final_batch THEN cardinality(v_valid_target_ids) ELSE automatic_membership_match_count END,
         automatic_membership_sync_error     = NULL,
         automatic_membership_cursor         = p_next_cursor
   WHERE id = p_group_id;

  RETURN jsonb_build_object(
    'ok', true,
    'inserted', v_inserted,
    'deleted', v_deleted,
    'role_updated', v_role_updated,
    'is_final_batch', p_is_final_batch,
    'next_cursor', p_next_cursor
  );
END;
$$;

REVOKE ALL ON FUNCTION reconcile_automatic_membership(UUID, UUID, TEXT, UUID[], UUID[], BOOLEAN, TEXT, INTEGER, BIGINT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reconcile_automatic_membership(UUID, UUID, TEXT, UUID[], UUID[], BOOLEAN, TEXT, INTEGER, BIGINT, TEXT) TO service_role;

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_mga_group_source
  ON member_group_assignment (group_id, assignment_source)
  WHERE assignment_source = 'automatic';

CREATE INDEX IF NOT EXISTS idx_mg_auto_sync_status
  ON member_group (automatic_membership_sync_status, automatic_membership_enabled, automatic_membership_last_synced_at)
  WHERE automatic_membership_enabled = true;

-- Delete BNMS members who are not attached to BNMS's one exact primary
-- organisation. The preflight creates or activates the tenant-scoped
-- "British Nuclear Medicine Society" Organisation when it is unambiguous.
--
-- SUPABASE SQL EDITOR RUNBOOK
-- 1. Run this file unchanged. Review every preview result set and NOTICE.
--    The supplied final statement is ROLLBACK, so this makes no lasting change.
-- 2. Save/export the preview. Confirm the tenant, primary organisation,
--    two approved legacy GFI bookings and their three dependents, preserved
--    members, candidate IDs, authentication links, and dependency counts are
--    exactly what is expected.
-- 3. Run the entire file again in one SQL Editor invocation. To apply, make
--    the ONE explicit switch at the bottom: replace ROLLBACK with COMMIT.
-- 4. Never run only the DELETE section: the temporary snapshots and assertions
--    are deliberate safety controls.
-- 5. Any later dependency-guard error is a separate data-safety blocker. Never
--    bypass one merely because the primary Organisation preflight succeeded.
--
-- This script intentionally does not delete tenant_identity rows. An identity
-- is shared and may still serve a preserved member or another tenant.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '15min';

-- Freeze tenant identity, primary markers, and member scope. The Organisation
-- lock also permits this transaction to create or activate the one exact
-- primary Organisation while blocking concurrent Organisation writes.
LOCK TABLE public.tenant IN SHARE MODE;
LOCK TABLE public.organization IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.member IN SHARE MODE;

CREATE TEMP TABLE _bnms_scope (
  tenant_id uuid PRIMARY KEY,
  tenant_slug text NOT NULL,
  tenant_name text NOT NULL,
  primary_organization_id uuid NOT NULL,
  primary_organization_name text NOT NULL,
  primary_resolution text NOT NULL
) ON COMMIT DROP;

-- Prove that resolving/creating the primary Organisation never reassigns a
-- Member. Unassigned Members deliberately remain cleanup candidates.
CREATE TEMP TABLE _bnms_member_organizations_before ON COMMIT DROP AS
SELECT id, organization_id
FROM public.member
WHERE tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid;
ALTER TABLE _bnms_member_organizations_before ADD PRIMARY KEY (id);

DO $preflight$
DECLARE
  v_tenant_id constant uuid := 'ff2df806-b321-4254-b651-3af11fccf1db';
  v_expected_slug constant text := 'bnms';
  v_expected_tenant_names constant text[] := ARRAY['BNMS', 'British Nuclear Medicine Society'];
  v_expected_organization_name constant text := 'British Nuclear Medicine Society';
  v_tenant record;
  v_name_match_count bigint;
  v_name_match_id uuid;
  v_primary_count bigint;
  v_primary_id uuid;
  v_primary_resolution text;
BEGIN
  SELECT id, slug, name
    INTO v_tenant
    FROM public.tenant
   WHERE id = v_tenant_id
   FOR SHARE;

  IF NOT FOUND
     OR v_tenant.slug IS DISTINCT FROM v_expected_slug
     OR NOT (v_tenant.name = ANY(v_expected_tenant_names)) THEN
    RAISE EXCEPTION
      'BNMS tenant identity check failed. Expected id=%, slug=%, name in %; found id=%, slug=%, name=%',
      v_tenant_id, v_expected_slug, v_expected_tenant_names,
      v_tenant.id, v_tenant.slug, v_tenant.name;
  END IF;

  SELECT count(*), (array_agg(id ORDER BY id))[1]
    INTO v_name_match_count, v_name_match_id
    FROM public.organization
   WHERE tenant_id = v_tenant_id
     AND lower(btrim(name)) = lower(v_expected_organization_name);

  IF v_name_match_count > 1 THEN
    RAISE EXCEPTION
      'Expected at most one BNMS organisation named "%"; found %. No organisation was guessed.',
      v_expected_organization_name, v_name_match_count;
  END IF;

  SELECT count(*), (array_agg(id ORDER BY id))[1]
    INTO v_primary_count, v_primary_id
    FROM public.organization
   WHERE tenant_id = v_tenant_id
     AND is_primary IS TRUE;

  IF v_primary_count > 1 THEN
    RAISE EXCEPTION
      'Expected at most one is_primary=true BNMS organisation before resolution; found %. No organisation was guessed.',
      v_primary_count;
  END IF;

  IF v_primary_count = 1
     AND (v_name_match_count = 0 OR v_primary_id IS DISTINCT FROM v_name_match_id) THEN
    RAISE EXCEPTION
      'Conflicting BNMS primary organisation % is not the exact "%" organisation. No marker was changed.',
      v_primary_id, v_expected_organization_name;
  END IF;

  IF v_name_match_count = 0 THEN
    INSERT INTO public.organization (tenant_id, name, status, is_primary)
    VALUES (v_tenant_id, v_expected_organization_name, 'active', true)
    RETURNING id INTO v_primary_id;
    v_primary_resolution := 'CREATED';
  ELSE
    v_primary_id := v_name_match_id;
    UPDATE public.organization
       SET name = v_expected_organization_name,
           status = 'active',
           is_primary = true
     WHERE tenant_id = v_tenant_id
       AND id = v_primary_id;
    v_primary_resolution := CASE
      WHEN v_primary_count = 1 THEN 'REUSED_EXISTING_PRIMARY'
      ELSE 'REUSED_AND_MARKED_PRIMARY'
    END;
  END IF;

  IF (
    SELECT count(*)
    FROM public.organization
    WHERE tenant_id = v_tenant_id
      AND is_primary IS TRUE
      AND id = v_primary_id
      AND name = v_expected_organization_name
      AND status = 'active'
  ) <> 1
  OR (
    SELECT count(*)
    FROM public.organization
    WHERE tenant_id = v_tenant_id
      AND is_primary IS TRUE
  ) <> 1 THEN
    RAISE EXCEPTION
      'BNMS primary organisation resolution failed its exact-name, active-status, or sole-primary assertion.';
  END IF;

  INSERT INTO _bnms_scope
    (tenant_id, tenant_slug, tenant_name, primary_organization_id,
     primary_organization_name, primary_resolution)
  VALUES
    (v_tenant_id, v_expected_slug, v_tenant.name, v_primary_id,
     v_expected_organization_name, v_primary_resolution);

  RAISE NOTICE
    'BNMS primary Organisation %: "%" (%)',
    v_primary_resolution, v_expected_organization_name, v_primary_id;
END
$preflight$;

DO $member_assignment_guard$
BEGIN
  IF EXISTS (
    SELECT before.id
    FROM _bnms_member_organizations_before before
    FULL JOIN (
      SELECT id, organization_id
      FROM public.member
      WHERE tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
    ) current ON current.id = before.id
    WHERE before.id IS NULL
       OR current.id IS NULL
       OR before.organization_id IS DISTINCT FROM current.organization_id
  ) THEN
    RAISE EXCEPTION
      'Primary Organisation resolution changed a BNMS Member organisation assignment; no cleanup was attempted.';
  END IF;
END
$member_assignment_guard$;

-- Freeze the exact sets used by preview, deletion, and postconditions.
CREATE TEMP TABLE _bnms_candidates ON COMMIT DROP AS
SELECT m.id
  FROM public.member m
  CROSS JOIN _bnms_scope s
 WHERE m.tenant_id = s.tenant_id
   AND m.organization_id IS NULL;
ALTER TABLE _bnms_candidates ADD PRIMARY KEY (id);

CREATE TEMP TABLE _bnms_preserved ON COMMIT DROP AS
SELECT m.id
  FROM public.member m
  CROSS JOIN _bnms_scope s
 WHERE m.tenant_id = s.tenant_id
   AND m.organization_id = s.primary_organization_id;
ALTER TABLE _bnms_preserved ADD PRIMARY KEY (id);

DO $approved_member_scope_guard$
BEGIN
  IF (SELECT count(*) FROM _bnms_candidates) <> 4192
  OR (SELECT count(*) FROM _bnms_preserved) <> 0
  OR (
    SELECT count(*)
    FROM public.member m
    CROSS JOIN _bnms_scope s
    WHERE m.tenant_id = s.tenant_id
  ) <> 4192
  OR EXISTS (
    SELECT 1
    FROM public.member m
    CROSS JOIN _bnms_scope s
    WHERE m.tenant_id = s.tenant_id
      AND m.organization_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Approved BNMS scope changed: expected exactly 4,192 total Members, all unassigned, with 0 preserved; no cleanup was attempted';
  END IF;
END
$approved_member_scope_guard$;

-- Two explicitly approved legacy GFI bookings point at BNMS candidate Members.
-- Keep this exception row-specific: validate every identifying attribute,
-- inventory every booking reference, and delete only the allowlisted rows.
LOCK TABLE public.event IN SHARE MODE;
LOCK TABLE public.event_email IN SHARE MODE;
LOCK TABLE public.booking IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.booking_cancellation_request IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.scheduled_email IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _approved_legacy_gfi_bookings (
  booking_id uuid PRIMARY KEY,
  expected_member_id uuid NOT NULL,
  expected_status text NOT NULL,
  expected_event_id uuid
) ON COMMIT DROP;

INSERT INTO _approved_legacy_gfi_bookings
  (booking_id, expected_member_id, expected_status, expected_event_id)
VALUES
  (
    '2d81e61f-ab8e-43ef-b811-53ba464457f1',
    'd0fcefde-e82c-48a5-b925-9075a026ddc4',
    'cancelled',
    NULL
  ),
  (
    '3c65d99c-b681-4c9e-a7e2-977dd943a9c9',
    '133db61a-e502-42cf-aa64-9ba287ea85ac',
    'confirmed',
    '5f2c04d1-75a0-4cdc-869e-badadba9da7a'
  );

CREATE TEMP TABLE _approved_legacy_gfi_booking_dependencies (
  table_name text NOT NULL,
  row_id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES _approved_legacy_gfi_bookings(booking_id)
) ON COMMIT DROP;

INSERT INTO _approved_legacy_gfi_booking_dependencies
  (table_name, row_id, booking_id)
VALUES
  (
    'booking_cancellation_request',
    '28d6c538-b1f7-4c82-b988-87e8ceb293a5',
    '2d81e61f-ab8e-43ef-b811-53ba464457f1'
  ),
  (
    'booking_cancellation_request',
    '62f50f3b-94d2-423d-8c89-015a23b19830',
    '2d81e61f-ab8e-43ef-b811-53ba464457f1'
  ),
  (
    'scheduled_email',
    'b1483d08-a159-4ab3-9b05-18cb1fafef49',
    '3c65d99c-b681-4c9e-a7e2-977dd943a9c9'
  );

CREATE TEMP TABLE _other_gfi_bookings ON COMMIT DROP AS
SELECT b.id
FROM public.booking b
WHERE b.tenant_id = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d'::uuid
  AND NOT EXISTS (
    SELECT 1
    FROM _approved_legacy_gfi_bookings approved
    WHERE approved.booking_id = b.id
  );
ALTER TABLE _other_gfi_bookings ADD PRIMARY KEY (id);

DO $approved_booking_preflight$
DECLARE
  v_gfi_tenant_id constant uuid := 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
  v_bnms_tenant_id constant uuid := 'ff2df806-b321-4254-b651-3af11fccf1db';
BEGIN
  IF (
    SELECT count(*)
    FROM public.tenant
    WHERE id = v_gfi_tenant_id
      AND slug = 'gfi'
  ) <> 1 THEN
    RAISE EXCEPTION 'Approved booking cleanup could not verify the pinned GFI tenant';
  END IF;

  IF (
    SELECT count(*)
    FROM _approved_legacy_gfi_bookings approved
    JOIN public.booking b
      ON b.id = approved.booking_id
     AND b.tenant_id = v_gfi_tenant_id
     AND b.member_id = approved.expected_member_id
     AND b.status = approved.expected_status
     AND b.event_id IS NOT DISTINCT FROM approved.expected_event_id
     AND b.created_at IS NULL
    JOIN public.member m
      ON m.id = b.member_id
     AND m.tenant_id = v_bnms_tenant_id
    JOIN _bnms_candidates candidate
      ON candidate.id = m.id
    LEFT JOIN public.event e
      ON e.id = b.event_id
     AND e.tenant_id = v_gfi_tenant_id
    WHERE approved.expected_event_id IS NULL OR e.id IS NOT NULL
  ) <> 2 THEN
    RAISE EXCEPTION
      'One or both approved legacy GFI booking signatures changed; no booking was deleted';
  END IF;

  IF (
    SELECT count(*)
    FROM public.booking b
    JOIN _approved_legacy_gfi_bookings approved ON approved.booking_id = b.id
  ) <> 2 THEN
    RAISE EXCEPTION
      'Expected exactly two approved legacy GFI bookings; no booking was deleted';
  END IF;

  IF (
    SELECT count(*)
    FROM public.booking_cancellation_request request
    JOIN _approved_legacy_gfi_booking_dependencies approved
      ON approved.table_name = 'booking_cancellation_request'
     AND approved.row_id = request.id
     AND approved.booking_id = request.booking_id
    JOIN _approved_legacy_gfi_bookings booking
      ON booking.booking_id = request.booking_id
     AND booking.expected_member_id = request.member_id
    WHERE request.tenant_id = v_gfi_tenant_id
      AND request.request_type = 'individual'
      AND request.status = 'approved'
      AND request.booking_source = 'booking'
  ) <> 2
  OR (
    SELECT count(*)
    FROM public.booking_cancellation_request request
    JOIN _approved_legacy_gfi_bookings approved
      ON approved.booking_id = request.booking_id
  ) <> 2 THEN
    RAISE EXCEPTION
      'Approved legacy booking cancellation-request signatures changed; no booking was deleted';
  END IF;

  IF (
    SELECT count(*)
    FROM public.scheduled_email email
    JOIN _approved_legacy_gfi_booking_dependencies approved
      ON approved.table_name = 'scheduled_email'
     AND approved.row_id = email.id
     AND approved.booking_id = email.booking_id
    JOIN public.event_email event_email
      ON event_email.id = email.event_email_id
     AND event_email.id = '59e3d8e0-34f5-4faf-8154-cd0a8ba25f00'::uuid
     AND event_email.event_id = '5f2c04d1-75a0-4cdc-869e-badadba9da7a'::uuid
    JOIN public.event event
      ON event.id = event_email.event_id
     AND event.tenant_id = v_gfi_tenant_id
    WHERE email.status = 'sent'
      AND email.sent_at IS NOT NULL
      AND email.session_id IS NULL
  ) <> 1
  OR (
    SELECT count(*)
    FROM public.scheduled_email email
    JOIN _approved_legacy_gfi_bookings approved
      ON approved.booking_id = email.booking_id
  ) <> 1 THEN
    RAISE EXCEPTION
      'Approved legacy booking scheduled-email signature changed; no booking was deleted';
  END IF;
END
$approved_booking_preflight$;

CREATE TEMP TABLE _approved_booking_references (
  schema_name text NOT NULL,
  table_name text NOT NULL,
  column_name text NOT NULL,
  matching_row_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (schema_name, table_name, column_name)
) ON COMMIT DROP;

INSERT INTO _approved_booking_references (schema_name, table_name, column_name)
SELECT
  ns.nspname,
  child.relname,
  child_col.attname
FROM pg_constraint fk
JOIN pg_class child ON child.oid = fk.conrelid
JOIN pg_namespace ns ON ns.oid = child.relnamespace
JOIN pg_class parent ON parent.oid = fk.confrelid
JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
JOIN LATERAL unnest(fk.conkey, fk.confkey) AS keys(child_attnum, parent_attnum)
  ON true
JOIN pg_attribute child_col
  ON child_col.attrelid = child.oid AND child_col.attnum = keys.child_attnum
JOIN pg_attribute parent_col
  ON parent_col.attrelid = parent.oid AND parent_col.attnum = keys.parent_attnum
WHERE fk.contype = 'f'
  AND ns.nspname = 'public'
  AND parent_ns.nspname = 'public'
  AND parent.relname = 'booking'
  AND parent_col.attname = 'id';

INSERT INTO _approved_booking_references (schema_name, table_name, column_name)
SELECT
  ns.nspname,
  tbl.relname,
  col.attname
FROM pg_attribute col
JOIN pg_class tbl ON tbl.oid = col.attrelid
JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
WHERE ns.nspname = 'public'
  AND tbl.relkind IN ('r', 'p')
  AND tbl.relname <> 'booking'
  AND col.attnum > 0
  AND NOT col.attisdropped
  AND col.attname ~ '(^booking_id$|_booking_id$)'
ON CONFLICT (schema_name, table_name, column_name) DO NOTHING;

DO $approved_booking_reference_inventory$
DECLARE
  r record;
  v_count bigint;
BEGIN
  FOR r IN
    SELECT DISTINCT schema_name, table_name
    FROM _approved_booking_references
    ORDER BY schema_name, table_name
  LOOP
    EXECUTE format('LOCK TABLE %I.%I IN SHARE MODE', r.schema_name, r.table_name);
  END LOOP;

  FOR r IN SELECT * FROM _approved_booking_references ORDER BY table_name, column_name
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I x '
      || 'JOIN _approved_legacy_gfi_bookings approved '
      || 'ON x.%I::text = approved.booking_id::text',
      r.schema_name, r.table_name, r.column_name
    ) INTO v_count;

    UPDATE _approved_booking_references
       SET matching_row_count = v_count
     WHERE schema_name = r.schema_name
       AND table_name = r.table_name
       AND column_name = r.column_name;

    IF v_count > 0
       AND NOT (
         r.schema_name = 'public'
         AND r.column_name = 'booking_id'
         AND r.table_name IN ('booking_cancellation_request', 'scheduled_email')
       ) THEN
      RAISE EXCEPTION
        'Unexpected reference to an approved legacy booking in %.%.% (% row(s)); no booking was deleted',
        r.schema_name, r.table_name, r.column_name, v_count;
    END IF;
  END LOOP;

  IF COALESCE((
    SELECT matching_row_count
    FROM _approved_booking_references
    WHERE schema_name = 'public'
      AND table_name = 'booking_cancellation_request'
      AND column_name = 'booking_id'
  ), 0) <> 2
  OR COALESCE((
    SELECT matching_row_count
    FROM _approved_booking_references
    WHERE schema_name = 'public'
      AND table_name = 'scheduled_email'
      AND column_name = 'booking_id'
  ), 0) <> 1 THEN
    RAISE EXCEPTION
      'Approved legacy booking dependency counts changed; no booking was deleted';
  END IF;
END
$approved_booking_reference_inventory$;

-- PREVIEW 0: the exact cross-tenant exception and all of its dependencies.
SELECT
  'DELETE LEGACY GFI BOOKING' AS disposition,
  b.id,
  b.tenant_id,
  b.member_id,
  b.event_id,
  b.status
FROM public.booking b
JOIN _approved_legacy_gfi_bookings approved ON approved.booking_id = b.id
ORDER BY b.id;

SELECT
  'DELETE LEGACY GFI BOOKING DEPENDENCY' AS disposition,
  approved.table_name,
  approved.row_id,
  approved.booking_id
FROM _approved_legacy_gfi_booking_dependencies approved
ORDER BY approved.table_name, approved.row_id;

SELECT *
FROM _approved_booking_references
WHERE matching_row_count > 0
ORDER BY table_name, column_name;

DO $delete_approved_legacy_gfi_bookings$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM public.booking_cancellation_request request
  USING _approved_legacy_gfi_booking_dependencies approved
  WHERE approved.table_name = 'booking_cancellation_request'
    AND approved.row_id = request.id
    AND approved.booking_id = request.booking_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 2 THEN
    RAISE EXCEPTION
      'Expected to delete two approved booking cancellation requests; deleted %',
      v_deleted;
  END IF;

  DELETE FROM public.scheduled_email email
  USING _approved_legacy_gfi_booking_dependencies approved
  WHERE approved.table_name = 'scheduled_email'
    AND approved.row_id = email.id
    AND approved.booking_id = email.booking_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 1 THEN
    RAISE EXCEPTION
      'Expected to delete one approved scheduled email; deleted %',
      v_deleted;
  END IF;

  DELETE FROM public.booking b
  USING _approved_legacy_gfi_bookings approved
  WHERE b.id = approved.booking_id
    AND b.tenant_id = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d'::uuid
    AND b.member_id = approved.expected_member_id
    AND b.status = approved.expected_status
    AND b.event_id IS NOT DISTINCT FROM approved.expected_event_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 2 THEN
    RAISE EXCEPTION
      'Expected to delete two approved legacy GFI bookings; deleted %',
      v_deleted;
  END IF;
END
$delete_approved_legacy_gfi_bookings$;

DO $approved_booking_delete_guard$
DECLARE
  r record;
  v_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.booking b
    JOIN _approved_legacy_gfi_bookings approved ON approved.booking_id = b.id
  )
  OR EXISTS (
    SELECT snapshot.id
    FROM _other_gfi_bookings snapshot
    EXCEPT
    SELECT id
    FROM public.booking
  ) THEN
    RAISE EXCEPTION
      'Approved legacy booking deletion removed the wrong GFI booking set';
  END IF;

  FOR r IN SELECT * FROM _approved_booking_references ORDER BY table_name, column_name
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I x '
      || 'JOIN _approved_legacy_gfi_bookings approved '
      || 'ON x.%I::text = approved.booking_id::text',
      r.schema_name, r.table_name, r.column_name
    ) INTO v_count;
    IF v_count <> 0 THEN
      RAISE EXCEPTION
        'Approved legacy booking reference remains in %.%.% (% row(s))',
        r.schema_name, r.table_name, r.column_name, v_count;
    END IF;
  END LOOP;
END
$approved_booking_delete_guard$;

DO $shared_bnms_identity_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.member candidate
    JOIN _bnms_candidates c ON c.id = candidate.id
    JOIN public.member preserved
      ON preserved.identity_id = candidate.identity_id
     AND preserved.id <> candidate.id
    JOIN _bnms_preserved p ON p.id = preserved.id
    WHERE candidate.identity_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'A candidate and preserved BNMS member share an identity. Resolve that authentication link before cleanup.';
  END IF;
END
$shared_bnms_identity_guard$;

CREATE TEMP TABLE _other_tenant_members ON COMMIT DROP AS
SELECT m.id
  FROM public.member m
  CROSS JOIN _bnms_scope s
 WHERE m.tenant_id IS DISTINCT FROM s.tenant_id;
ALTER TABLE _other_tenant_members ADD PRIMARY KEY (id);

-- Discover all live FK references to member(id), plus member-shaped soft
-- references. Soft references include legacy VARCHAR member IDs.
CREATE TEMP TABLE _bnms_member_references (
  schema_name text NOT NULL,
  table_name text NOT NULL,
  column_name text NOT NULL,
  delete_rule "char",
  is_nullable boolean NOT NULL,
  has_tenant_id boolean NOT NULL,
  candidate_row_count bigint NOT NULL DEFAULT 0,
  unscoped_candidate_row_count bigint NOT NULL DEFAULT 0,
  planned_action text,
  PRIMARY KEY (schema_name, table_name, column_name)
) ON COMMIT DROP;

INSERT INTO _bnms_member_references
  (schema_name, table_name, column_name, delete_rule, is_nullable, has_tenant_id)
SELECT
  ns.nspname,
  child.relname,
  child_col.attname,
  fk.confdeltype,
  NOT child_col.attnotnull,
  EXISTS (
    SELECT 1
      FROM pg_attribute tenant_col
     WHERE tenant_col.attrelid = child.oid
       AND tenant_col.attname = 'tenant_id'
       AND tenant_col.attnum > 0
       AND NOT tenant_col.attisdropped
  )
FROM pg_constraint fk
JOIN pg_class child ON child.oid = fk.conrelid
JOIN pg_namespace ns ON ns.oid = child.relnamespace
JOIN pg_class parent ON parent.oid = fk.confrelid
JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
JOIN LATERAL unnest(fk.conkey, fk.confkey) AS keys(child_attnum, parent_attnum)
  ON true
JOIN pg_attribute child_col
  ON child_col.attrelid = child.oid AND child_col.attnum = keys.child_attnum
JOIN pg_attribute parent_col
  ON parent_col.attrelid = parent.oid AND parent_col.attnum = keys.parent_attnum
WHERE fk.contype = 'f'
  AND ns.nspname = 'public'
  AND parent_ns.nspname = 'public'
  AND parent.relname = 'member'
  AND parent_col.attname = 'id'
  AND child.relname <> 'member';

INSERT INTO _bnms_member_references
  (schema_name, table_name, column_name, delete_rule, is_nullable, has_tenant_id)
SELECT
  ns.nspname,
  tbl.relname,
  col.attname,
  NULL,
  NOT col.attnotnull,
  EXISTS (
    SELECT 1
      FROM pg_attribute tenant_col
     WHERE tenant_col.attrelid = tbl.oid
       AND tenant_col.attname = 'tenant_id'
       AND tenant_col.attnum > 0
       AND NOT tenant_col.attisdropped
  )
FROM pg_attribute col
JOIN pg_class tbl ON tbl.oid = col.attrelid
JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
WHERE ns.nspname = 'public'
  AND tbl.relkind IN ('r', 'p')
  AND tbl.relname <> 'member'
  AND col.attnum > 0
  AND NOT col.attisdropped
  AND col.attname ~ '(^member_id$|_member_id$)'
ON CONFLICT (schema_name, table_name, column_name) DO NOTHING;

DO $inventory$
DECLARE
  r record;
  v_count bigint;
  v_foreign_count bigint;
  v_unscoped_count bigint;
BEGIN
  -- Freeze every discovered dependency table before inventorying it. This
  -- keeps preview counts, cleanup, and dangling-reference checks consistent.
  FOR r IN
    SELECT DISTINCT schema_name, table_name
    FROM _bnms_member_references
    ORDER BY schema_name, table_name
  LOOP
    EXECUTE format('LOCK TABLE %I.%I IN SHARE MODE', r.schema_name, r.table_name);
  END LOOP;

  FOR r IN SELECT * FROM _bnms_member_references ORDER BY table_name, column_name
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I x JOIN _bnms_candidates c ON x.%I::text = c.id::text',
      r.schema_name, r.table_name, r.column_name
    ) INTO v_count;

    IF r.has_tenant_id THEN
      EXECUTE format(
        'SELECT count(*) FROM %I.%I x JOIN _bnms_candidates c ON x.%I::text = c.id::text '
        || 'CROSS JOIN _bnms_scope s '
        || 'WHERE x.tenant_id IS NOT NULL '
        || 'AND x.tenant_id::text IS DISTINCT FROM s.tenant_id::text',
        r.schema_name, r.table_name, r.column_name
      ) INTO v_foreign_count;
      IF v_foreign_count <> 0 THEN
        RAISE EXCEPTION
          'Cross-tenant guard: %.%.% has % non-BNMS row(s) referencing deletion candidates',
          r.schema_name, r.table_name, r.column_name, v_foreign_count;
      END IF;

      EXECUTE format(
        'SELECT count(*) FROM %I.%I x JOIN _bnms_candidates c ON x.%I::text = c.id::text '
        || 'WHERE x.tenant_id IS NULL',
        r.schema_name, r.table_name, r.column_name
      ) INTO v_unscoped_count;

      IF r.schema_name = 'public'
         AND r.table_name = 'member_credentials'
         AND r.column_name = 'member_id' THEN
        IF v_unscoped_count <> 14 OR v_count <> 14 THEN
          RAISE EXCEPTION
            'Approved legacy member_credentials scope changed: expected exactly 14 candidate rows, all with NULL tenant_id; found % total and % unscoped',
            v_count, v_unscoped_count;
        END IF;
        RAISE NOTICE
          'Approved legacy unscoped dependency: %.%.% has % candidate-owned row(s)',
          r.schema_name, r.table_name, r.column_name, v_unscoped_count;
      ELSIF v_unscoped_count <> 0 THEN
        RAISE EXCEPTION
          'Unscoped-row guard: %.%.% has % NULL-tenant row(s) referencing deletion candidates',
          r.schema_name, r.table_name, r.column_name, v_unscoped_count;
      END IF;
    ELSE
      v_unscoped_count := 0;
    END IF;

    UPDATE _bnms_member_references
       SET candidate_row_count = v_count,
           unscoped_candidate_row_count = v_unscoped_count,
           planned_action = CASE
             WHEN r.delete_rule = 'c' THEN 'FK CASCADE on member delete'
             WHEN r.delete_rule = 'n' THEN 'FK SET NULL on member delete'
             WHEN r.delete_rule = 'd' THEN 'FK SET DEFAULT on member delete'
             WHEN r.is_nullable THEN 'detach (SET NULL)'
             ELSE 'delete dependent row'
           END
     WHERE schema_name = r.schema_name
       AND table_name = r.table_name
       AND column_name = r.column_name;
  END LOOP;
END
$inventory$;

-- A required direct dependent can only be deleted safely when no restrictive
-- grandchild points at the affected row. Detect those chains before mutation.
-- We deliberately abort rather than inventing a business policy for indirectly
-- related records that this member cleanup did not explicitly select.
CREATE TEMP TABLE _bnms_restrictive_dependency_blockers (
  parent_schema text NOT NULL,
  parent_table text NOT NULL,
  parent_member_column text NOT NULL,
  child_schema text NOT NULL,
  child_table text NOT NULL,
  constraint_name text NOT NULL,
  affected_child_rows bigint NOT NULL
) ON COMMIT DROP;

DO $restrictive_dependency_preflight$
DECLARE
  direct_ref record;
  fk record;
  child_column text;
  parent_column text;
  join_predicate text;
  affected_count bigint;
  column_index integer;
BEGIN
  FOR direct_ref IN
    SELECT refs.*, tbl.oid AS parent_oid
    FROM _bnms_member_references refs
    JOIN pg_namespace ns ON ns.nspname = refs.schema_name
    JOIN pg_class tbl
      ON tbl.relnamespace = ns.oid
     AND tbl.relname = refs.table_name
    WHERE refs.candidate_row_count > 0
      AND refs.is_nullable IS FALSE
      AND refs.delete_rule IS DISTINCT FROM 'c'
      AND refs.delete_rule IS DISTINCT FROM 'n'
      AND refs.delete_rule IS DISTINCT FROM 'd'
    ORDER BY refs.schema_name, refs.table_name, refs.column_name
  LOOP
    FOR fk IN
      SELECT
        constraint_row.conname,
        constraint_row.conrelid,
        constraint_row.conkey,
        constraint_row.confkey,
        child_ns.nspname AS child_schema,
        child.relname AS child_table
      FROM pg_constraint constraint_row
      JOIN pg_class child ON child.oid = constraint_row.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      WHERE constraint_row.contype = 'f'
        AND constraint_row.confrelid = direct_ref.parent_oid
        AND constraint_row.confdeltype IN ('a', 'r')
      ORDER BY child_ns.nspname, child.relname, constraint_row.conname
    LOOP
      -- Lock before inventory so the reported dependency chain cannot change.
      EXECUTE format(
        'LOCK TABLE %I.%I IN SHARE MODE',
        fk.child_schema, fk.child_table
      );

      join_predicate := '';
      FOR column_index IN 1..array_length(fk.conkey, 1)
      LOOP
        SELECT attname INTO child_column
        FROM pg_attribute
        WHERE attrelid = fk.conrelid
          AND attnum = fk.conkey[column_index];

        SELECT attname INTO parent_column
        FROM pg_attribute
        WHERE attrelid = direct_ref.parent_oid
          AND attnum = fk.confkey[column_index];

        join_predicate := concat_ws(
          ' AND ',
          NULLIF(join_predicate, ''),
          format('child.%I IS NOT DISTINCT FROM parent.%I', child_column, parent_column)
        );
      END LOOP;

      EXECUTE format(
        'SELECT count(*) FROM %I.%I child '
        || 'JOIN %I.%I parent ON %s '
        || 'JOIN _bnms_candidates candidate '
        || 'ON parent.%I::text = candidate.id::text',
        fk.child_schema,
        fk.child_table,
        direct_ref.schema_name,
        direct_ref.table_name,
        join_predicate,
        direct_ref.column_name
      ) INTO affected_count;

      IF affected_count > 0 THEN
        INSERT INTO _bnms_restrictive_dependency_blockers (
          parent_schema,
          parent_table,
          parent_member_column,
          child_schema,
          child_table,
          constraint_name,
          affected_child_rows
        ) VALUES (
          direct_ref.schema_name,
          direct_ref.table_name,
          direct_ref.column_name,
          fk.child_schema,
          fk.child_table,
          fk.conname,
          affected_count
        );
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (SELECT 1 FROM _bnms_restrictive_dependency_blockers) THEN
    FOR fk IN
      SELECT * FROM _bnms_restrictive_dependency_blockers
      ORDER BY parent_schema, parent_table, child_schema, child_table, constraint_name
    LOOP
      RAISE NOTICE
        'Blocked dependency: %.% (via %) <- %.% constraint %, affected rows %',
        fk.parent_schema,
        fk.parent_table,
        fk.parent_member_column,
        fk.child_schema,
        fk.child_table,
        fk.constraint_name,
        fk.affected_child_rows;
    END LOOP;
    RAISE EXCEPTION
      'Restrictive child dependencies would make cleanup order unsafe. Review the NOTICE chains; no rows were changed.';
  END IF;
END
$restrictive_dependency_preflight$;

-- PREVIEW 1: protected scope and organisation distribution.
SELECT
  s.tenant_id,
  s.tenant_slug,
  s.tenant_name,
  s.primary_organization_id,
  s.primary_resolution,
  o.name AS primary_organization_name,
  o.status AS primary_organization_status,
  o.is_primary,
  (SELECT count(*) FROM _bnms_preserved) AS preserved_member_count,
  (SELECT count(*) FROM _bnms_candidates) AS candidate_member_count,
  (SELECT count(*) FROM _bnms_member_organizations_before WHERE organization_id IS NULL)
    AS unassigned_member_count_before_cleanup
FROM _bnms_scope s
JOIN public.organization o
  ON o.id = s.primary_organization_id
 AND o.tenant_id = s.tenant_id;

SELECT
  m.organization_id,
  COALESCE(o.name, '(no organisation)') AS organization_name,
  (o.id IS NOT NULL AND o.is_primary IS TRUE) AS is_primary,
  count(*) AS member_count,
  count(*) FILTER (WHERE c.id IS NOT NULL) AS candidate_count
FROM public.member m
CROSS JOIN _bnms_scope s
LEFT JOIN public.organization o
  ON o.id = m.organization_id AND o.tenant_id = s.tenant_id
LEFT JOIN _bnms_candidates c ON c.id = m.id
WHERE m.tenant_id = s.tenant_id
GROUP BY m.organization_id, o.name, o.id, o.is_primary
ORDER BY is_primary DESC, organization_name, m.organization_id;

-- PREVIEW 2: exact preserved and candidate member sets.
SELECT 'PRESERVE' AS disposition, m.id, m.email, m.organization_id
FROM public.member m JOIN _bnms_preserved p ON p.id = m.id
ORDER BY m.id;

SELECT 'DELETE' AS disposition, m.id, m.email, m.organization_id, m.identity_id
FROM public.member m JOIN _bnms_candidates c ON c.id = m.id
ORDER BY m.id;

-- PREVIEW 3: all dependent rows and the action selected from the live schema.
SELECT
  schema_name,
  table_name,
  column_name,
  candidate_row_count,
  unscoped_candidate_row_count,
  planned_action,
  has_tenant_id
FROM _bnms_member_references
WHERE candidate_row_count > 0
ORDER BY table_name, column_name;

-- PREVIEW 4: authentication links at reviewable row granularity. Shared
-- tenant_identity rows are reported, not deleted.
SELECT
  m.id AS candidate_member_id,
  m.email,
  m.identity_id,
  EXISTS (
    SELECT 1 FROM public.member kept
    WHERE kept.id <> m.id AND kept.identity_id = m.identity_id
  ) AS identity_used_by_another_member,
  EXISTS (
    SELECT 1 FROM public.tenant_membership other_tm
    CROSS JOIN _bnms_scope s
    WHERE other_tm.identity_id = m.identity_id
      AND other_tm.tenant_id::text <> s.tenant_id::text
  ) AS identity_used_by_another_tenant
FROM public.member m
JOIN _bnms_candidates c ON c.id = m.id
WHERE m.identity_id IS NOT NULL
ORDER BY m.id;

SELECT
  'tenant_membership' AS link_table,
  tm.id::text AS link_id,
  tm.tenant_id::text AS link_tenant_id,
  tm.identity_id::text AS identity_id,
  tm.member_id::text AS candidate_member_id
FROM public.tenant_membership tm
JOIN _bnms_candidates c ON tm.member_id::text = c.id::text
UNION ALL
SELECT
  'tenant_user_member_link',
  tul.id::text,
  tul.tenant_id::text,
  NULL,
  tul.member_id::text
FROM public.tenant_user_member_link tul
JOIN _bnms_candidates c ON tul.member_id::text = c.id::text
UNION ALL
SELECT
  'member_credentials',
  mc.member_id::text,
  mc.tenant_id::text,
  NULL,
  mc.member_id::text
FROM public.member_credentials mc
JOIN _bnms_candidates c ON mc.member_id::text = c.id::text
UNION ALL
SELECT
  'portal_sso_token',
  pst.id::text,
  pst.tenant_id::text,
  NULL,
  pst.member_id::text
FROM public.portal_sso_token pst
JOIN _bnms_candidates c ON pst.member_id::text = c.id::text
ORDER BY link_table, link_id;

-- PostgreSQL checks restrictive FKs once per deleted Member. DEST has three
-- large child tables without a leading index on member_id, which otherwise
-- turns this cleanup into thousands of full-table scans. Build transaction-
-- local helper indexes only when needed, retain them through postconditions,
-- then drop them before the final ROLLBACK/COMMIT switch.
CREATE TEMP TABLE _bnms_cleanup_helper_indexes (
  schema_name text NOT NULL,
  table_name text NOT NULL,
  column_name text NOT NULL,
  index_name text PRIMARY KEY
) ON COMMIT DROP;

DO $create_cleanup_helper_indexes$
DECLARE
  r record;
  v_table_oid oid;
  v_column_number smallint;
BEGIN
  FOR r IN
    SELECT *
    FROM (VALUES
      (
        'public',
        'email_event',
        'member_id',
        '_bnms_cleanup_email_event_member_id_idx'
      ),
      (
        'public',
        'email_link_click',
        'member_id',
        '_bnms_cleanup_email_link_click_member_id_idx'
      ),
      (
        'public',
        'email_campaign_recipient',
        'member_id',
        '_bnms_cleanup_email_campaign_recipient_member_id_idx'
      )
    ) AS expected(schema_name, table_name, column_name, index_name)
  LOOP
    SELECT tbl.oid, col.attnum
      INTO v_table_oid, v_column_number
    FROM pg_class tbl
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    JOIN pg_attribute col
      ON col.attrelid = tbl.oid
     AND col.attname = r.column_name
     AND col.attnum > 0
     AND NOT col.attisdropped
    WHERE ns.nspname = r.schema_name
      AND tbl.relname = r.table_name
      AND tbl.relkind IN ('r', 'p');

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Required cleanup index target %.%.% is missing',
        r.schema_name, r.table_name, r.column_name;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_index idx
      WHERE idx.indrelid = v_table_oid
        AND idx.indisvalid
        AND idx.indisready
        AND idx.indkey[0] = v_column_number
    ) THEN
      EXECUTE format(
        'CREATE INDEX %I ON %I.%I (%I)',
        r.index_name, r.schema_name, r.table_name, r.column_name
      );

      INSERT INTO _bnms_cleanup_helper_indexes
        (schema_name, table_name, column_name, index_name)
      VALUES
        (r.schema_name, r.table_name, r.column_name, r.index_name);

      RAISE NOTICE
        'Created transaction-local cleanup helper index % on %.%.%',
        r.index_name, r.schema_name, r.table_name, r.column_name;
    END IF;
  END LOOP;
END
$create_cleanup_helper_indexes$;

-- Detach NO ACTION/RESTRICT and soft references when nullable. Delete only
-- candidate-owned dependent records whose member reference cannot be null.
-- CASCADE and SET NULL constraints are intentionally left to PostgreSQL.
DO $cleanup_dependencies$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT *
      FROM _bnms_member_references
     WHERE candidate_row_count > 0
       AND delete_rule IS DISTINCT FROM 'c'
       AND delete_rule IS DISTINCT FROM 'n'
       AND delete_rule IS DISTINCT FROM 'd'
     ORDER BY is_nullable DESC, table_name, column_name
  LOOP
    IF r.is_nullable THEN
      EXECUTE format(
        'UPDATE %I.%I x SET %I = NULL FROM _bnms_candidates c WHERE x.%I::text = c.id::text',
        r.schema_name, r.table_name, r.column_name, r.column_name
      );
    ELSE
      EXECUTE format(
        'DELETE FROM %I.%I x USING _bnms_candidates c WHERE x.%I::text = c.id::text',
        r.schema_name, r.table_name, r.column_name
      );
    END IF;
  END LOOP;
END
$cleanup_dependencies$;

DELETE FROM public.member m
USING _bnms_candidates c, _bnms_scope s
WHERE m.id = c.id
  AND m.tenant_id = s.tenant_id
  AND m.organization_id IS NULL;

DO $postconditions$
DECLARE
  r record;
  v_count bigint;
BEGIN
  IF (
    SELECT count(*)
    FROM public.organization o
    CROSS JOIN _bnms_scope s
    WHERE o.tenant_id = s.tenant_id
      AND o.is_primary IS TRUE
      AND o.id = s.primary_organization_id
      AND o.name = s.primary_organization_name
      AND o.status = 'active'
  ) <> 1
  OR (
    SELECT count(*)
    FROM public.organization o
    CROSS JOIN _bnms_scope s
    WHERE o.tenant_id = s.tenant_id
      AND o.is_primary IS TRUE
  ) <> 1 THEN
    RAISE EXCEPTION 'Postcondition failed: live BNMS primary organisation changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.member m JOIN _bnms_candidates c ON c.id = m.id
  ) THEN
    RAISE EXCEPTION 'Postcondition failed: at least one candidate member remains';
  END IF;

  IF EXISTS (
    SELECT id FROM _bnms_preserved
    EXCEPT
    SELECT id FROM public.member
  ) THEN
    RAISE EXCEPTION 'Postcondition failed: at least one preserved primary-organisation member was removed';
  END IF;

  IF EXISTS (
    SELECT id FROM _other_tenant_members
    EXCEPT
    SELECT id FROM public.member
  ) THEN
    RAISE EXCEPTION 'Postcondition failed: at least one out-of-tenant member was removed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member m
    CROSS JOIN _bnms_scope s
    WHERE m.tenant_id = s.tenant_id
  ) THEN
    RAISE EXCEPTION 'Postcondition failed: a live BNMS member remains';
  END IF;

  FOR r IN SELECT * FROM _bnms_member_references ORDER BY table_name, column_name
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I x JOIN _bnms_candidates c ON x.%I::text = c.id::text',
      r.schema_name, r.table_name, r.column_name
    ) INTO v_count;
    IF v_count <> 0 THEN
      RAISE EXCEPTION
        'Postcondition failed: %.%.% has % dangling candidate reference(s)',
        r.schema_name, r.table_name, r.column_name, v_count;
    END IF;
  END LOOP;

  RAISE NOTICE
    'All postconditions passed: candidates gone, preserved members present, other tenants unchanged, no dangling member references.';
END
$postconditions$;

DO $drop_cleanup_helper_indexes$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT *
    FROM _bnms_cleanup_helper_indexes
    ORDER BY schema_name, index_name
  LOOP
    EXECUTE format(
      'DROP INDEX %I.%I',
      r.schema_name, r.index_name
    );
    RAISE NOTICE
      'Dropped transaction-local cleanup helper index %',
      r.index_name;
  END LOOP;
END
$drop_cleanup_helper_indexes$;

SELECT
  (SELECT count(*) FROM _bnms_candidates) AS members_deleted_in_transaction,
  (SELECT count(*) FROM _bnms_preserved) AS preserved_members_verified,
  (SELECT count(*) FROM _other_tenant_members) AS out_of_tenant_members_verified,
  'Postconditions passed; final transaction action is still below.' AS status;

-- ============================================================================
-- THE SINGLE APPLY SWITCH
-- Safe/default review run:
ROLLBACK;
-- Destructive apply run: replace the ROLLBACK line above with exactly COMMIT.
-- ============================================================================
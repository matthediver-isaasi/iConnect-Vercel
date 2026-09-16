-- Microsite fence for generation-aware Canvas publication.
--
-- This migration is intentionally additive to the focused publisher repair.
-- It does not change retrieval, add a dependency table, or alter the six
-- publisher arguments.  It must run after 001-publish.sql and 002-canvas.sql.
--
-- Lock order:
--   Canvas publisher: page read -> microsite -> i_edit_page -> symbol sources
--                    -> page source
--   Microsite change: microsite (the DML row lock) -> page sources
--
-- In particular, no publisher path may acquire the page source lock and then
-- wait for a microsite row.  That would deadlock with this trigger while a
-- prefix/active-state change is being committed.

DO $migration$
BEGIN
  IF to_regclass('public.microsite') IS NULL
     OR to_regclass('public.i_edit_page') IS NULL
     OR to_regclass('public.member_content_source') IS NULL THEN
    RAISE EXCEPTION
      'microsite Canvas fence requires microsite, i_edit_page, and member_content_source';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'microsite'
      AND column_name = 'id'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'microsite'
      AND column_name = 'tenant_id'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'microsite'
      AND column_name = 'path_prefix'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'microsite'
      AND column_name = 'is_active'
  ) THEN
    RAISE EXCEPTION
      'microsite Canvas fence requires microsite id, tenant_id, path_prefix, and is_active';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'i_edit_page'
      AND column_name = 'id'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'i_edit_page'
      AND column_name = 'tenant_id'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'i_edit_page'
      AND column_name = 'microsite_id'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'i_edit_page'
      AND column_name = 'builder_type'
  ) THEN
    RAISE EXCEPTION
      'microsite Canvas fence requires i_edit_page id, tenant_id, microsite_id, and builder_type';
  END IF;

  IF to_regprocedure(
       'public.invalidate_member_content_source(uuid,text,uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'microsite Canvas fence requires invalidate_member_content_source(uuid,text,uuid)';
  END IF;

  IF to_regprocedure(
       'public.publish_member_content_repair(uuid,text,uuid,bigint,uuid,jsonb)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'microsite Canvas fence requires the six-argument publisher from 002-canvas.sql';
  END IF;
END;
$migration$;

/*
 * Match JavaScript encodeURIComponent exactly for the canonical route
 * segments.  PostgreSQL text is already valid Unicode, so iterating its UTF-8
 * bytes produces the same percent-encoded octets as the Canvas helper.  Keep
 * this function private: only the SECURITY DEFINER publisher wrapper needs it.
 */
CREATE OR REPLACE FUNCTION public.microsite_member_content_uri_component(
  p_value text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
DECLARE
  encoded text := '';
  value_bytes bytea := convert_to(p_value, 'UTF8');
  index integer;
  octet integer;
BEGIN
  IF octet_length(value_bytes) = 0 THEN
    RETURN encoded;
  END IF;

  FOR index IN 0 .. octet_length(value_bytes) - 1 LOOP
    octet := get_byte(value_bytes, index);
    IF (octet BETWEEN 48 AND 57)
       OR (octet BETWEEN 65 AND 90)
       OR (octet BETWEEN 97 AND 122)
       OR octet IN (45, 46, 95, 33, 126, 42, 39, 40, 41) THEN
      encoded := encoded || chr(octet);
    ELSE
      encoded := encoded || '%' || upper(lpad(to_hex(octet), 2, '0'));
    END IF;
  END LOOP;

  RETURN encoded;
END;
$function$;

REVOKE ALL ON FUNCTION public.microsite_member_content_uri_component(text)
  FROM PUBLIC, anon, authenticated, service_role;

/*
 * The source invalidation RPC already owns the generation/queue contract.
 * Reuse it for every Canvas page in the changed microsite; do not delete
 * chunks or write retrieval state from this trigger.
 *
 * A page is associated with a microsite only within the page's own tenant.
 * This predicate is deliberate: a malformed cross-tenant microsite_id must
 * not let one tenant's microsite update invalidate another tenant's source.
 * On a tenant transfer, both the old and new tenant association sets are
 * invalidated because the microsite key is globally identified by id while
 * page rows are tenant-scoped.
 */
CREATE OR REPLACE FUNCTION public.microsite_member_content_change_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  page_row record;
  changed boolean;
BEGIN
  changed :=
    TG_OP = 'DELETE'
    OR (
      TG_OP = 'UPDATE'
      AND (
        NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.path_prefix IS DISTINCT FROM OLD.path_prefix
        OR NEW.is_active IS DISTINCT FROM OLD.is_active
      )
    );

  IF NOT changed THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  FOR page_row IN
    SELECT p.id, p.tenant_id
    FROM public.i_edit_page AS p
    WHERE p.microsite_id = OLD.id
      AND p.tenant_id = OLD.tenant_id
      AND p.builder_type = 'canvas'
    ORDER BY p.id
  LOOP
    PERFORM public.invalidate_member_content_source(
      page_row.tenant_id,
      'canvas_page',
      page_row.id
    );
  END LOOP;

  IF TG_OP = 'UPDATE'
     AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    FOR page_row IN
      SELECT p.id, p.tenant_id
      FROM public.i_edit_page AS p
      WHERE p.microsite_id = NEW.id
        AND p.tenant_id = NEW.tenant_id
        AND p.builder_type = 'canvas'
      ORDER BY p.id
    LOOP
      PERFORM public.invalidate_member_content_source(
        page_row.tenant_id,
        'canvas_page',
        page_row.id
      );
    END LOOP;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.microsite_member_content_change_trigger()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS microsite_member_content_change
  ON public.microsite;

CREATE TRIGGER microsite_member_content_change
  BEFORE DELETE OR UPDATE OF id, tenant_id, path_prefix, is_active
  ON public.microsite
  FOR EACH ROW
  EXECUTE FUNCTION public.microsite_member_content_change_trigger();

/*
 * Keep the original six-argument implementation intact under a private name
 * and put the microsite fence around it.  This avoids copying or drifting the
 * large generation/CAS implementation from 002-canvas.sql.
 */
DO $rename$
DECLARE
  current_definition text;
  current_oid oid;
BEGIN
  SELECT to_regprocedure(
    'public.publish_member_content_repair(uuid,text,uuid,bigint,uuid,jsonb)'
  )
  INTO current_oid;

  IF current_oid IS NULL THEN
    RAISE EXCEPTION
      'cannot fence publisher: six-argument implementation is missing';
  END IF;

  /*
   * On an ordered manifest repeat, 001/002 have restored the public function
   * to the current Canvas core. Replace the private copy so it cannot remain
   * stale after a core edit. A standalone repeat of this file sees the marker
   * below and must retain the already-installed core; otherwise it would
   * rename the wrapper into itself and recurse forever.
   */
  SELECT pg_get_functiondef(current_oid)
  INTO current_definition;
  IF current_definition LIKE '%MICROSITE_FENCE_WRAPPER_V1%' THEN
    IF to_regprocedure(
         'public.publish_member_content_repair_unfenced(uuid,text,uuid,bigint,uuid,jsonb)'
       ) IS NULL THEN
      RAISE EXCEPTION
        'microsite wrapper is installed but its private publisher core is missing';
    END IF;
  ELSE
    DROP FUNCTION IF EXISTS public.publish_member_content_repair_unfenced(
      uuid, text, uuid, bigint, uuid, jsonb
    );
    ALTER FUNCTION public.publish_member_content_repair(
      uuid, text, uuid, bigint, uuid, jsonb
    ) RENAME TO publish_member_content_repair_unfenced;
  END IF;
END;
$rename$;

/*
 * The old public implementation carried the service_role grant. It is now a
 * private implementation detail and must not remain directly callable.
 */
REVOKE ALL ON FUNCTION public.publish_member_content_repair_unfenced(
  uuid, text, uuid, bigint, uuid, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

/*
 * The wrapper receives the same six-argument contract as the existing worker.
 * Claims happen in the preceding RPC, so this validation is after claim
 * acquisition.  It first reads the canonical page without locking, locks the
 * discovered microsite, then locks/rereads the page before the private
 * publisher can lock member_content_source.
 *
 * A nonempty Canvas snapshot is accepted only when:
 *   - the claimed page still belongs to the requested tenant and is Canvas;
 *   - every payload row agrees on microsite_id and link;
 *   - the page's current microsite is the payload microsite;
 *   - that microsite still exists for the same tenant and is active; and
 *   - the saved link equals the current canonical /prefix/slug route.
 *
 * Empty snapshots remain valid tombstones for deleted/unindexable pages.  The
 * source generation/claim CAS in the private publisher still fences them.
 */
CREATE OR REPLACE FUNCTION public.publish_member_content_repair(
  p_tenant_id uuid,
  p_content_type text,
  p_source_id uuid,
  p_generation bigint,
  p_claim_token uuid,
  p_rows jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
-- MICROSITE_FENCE_WRAPPER_V1
DECLARE
  initial_page_row record;
  page_row record;
  microsite_row record;
  payload_row jsonb;
  candidate_microsite_id uuid;
  payload_microsite_id uuid;
  payload_link text;
  payload_seen boolean := false;
  expected_link text;
  page_found boolean := false;
  locked_page_found boolean := false;
  microsite_found boolean := false;
BEGIN
  /*
   * Preserve the deployed readiness probe exactly.  It must return false
   * without touching a source, page, microsite, or queue row.
   */
  IF p_tenant_id IS NULL
     AND p_content_type IS NULL
     AND p_source_id IS NULL
     AND p_generation IS NULL
     AND p_claim_token IS NULL
     AND jsonb_typeof(p_rows) = 'array'
     AND jsonb_array_length(p_rows) = 0 THEN
    RETURN false;
  END IF;

  IF p_content_type <> 'canvas_page' THEN
    RETURN public.publish_member_content_repair_unfenced(
      p_tenant_id,
      p_content_type,
      p_source_id,
      p_generation,
      p_claim_token,
      p_rows
    );
  END IF;

  -- Let the existing publisher issue its canonical JSON/type errors.
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN public.publish_member_content_repair_unfenced(
      p_tenant_id,
      p_content_type,
      p_source_id,
      p_generation,
      p_claim_token,
      p_rows
    );
  END IF;
  IF jsonb_array_length(p_rows) > 100 THEN
    RETURN public.publish_member_content_repair_unfenced(
      p_tenant_id,
      p_content_type,
      p_source_id,
      p_generation,
      p_claim_token,
      p_rows
    );
  END IF;

  /*
   * Parse only the two microsite identity fields needed for the fence.  The
   * private publisher remains responsible for full row and metadata
   * validation.  A malformed microsite id is a stale/no-op, not a way to
   * address a row in another tenant.
   */
  IF jsonb_array_length(p_rows) > 0 THEN
    FOR payload_row IN
      SELECT value
      FROM jsonb_array_elements(p_rows) AS item(value)
    LOOP
      candidate_microsite_id := NULL;
      IF NULLIF(payload_row->>'microsite_id', '') IS NOT NULL THEN
        BEGIN
          candidate_microsite_id :=
            (payload_row->>'microsite_id')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN false;
        END;
      END IF;

      IF NOT payload_seen THEN
        payload_microsite_id := candidate_microsite_id;
        payload_link := payload_row->>'link';
        payload_seen := true;
      ELSIF candidate_microsite_id IS DISTINCT FROM payload_microsite_id
         OR (payload_row->>'link') IS DISTINCT FROM payload_link THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;

  /*
   * Read the page without a row lock to discover its microsite, then acquire
   * the microsite tuple lock first.  This is important for microsite DELETE
   * statements with an FK action that also locks associated page rows.
   */
  SELECT
    p.id,
    p.tenant_id,
    p.slug,
    p.microsite_id,
    p.builder_type
  INTO initial_page_row
  FROM public.i_edit_page AS p
  WHERE p.id = p_source_id
    AND p.tenant_id = p_tenant_id
    AND p.builder_type = 'canvas';
  page_found := FOUND;

  IF page_found AND initial_page_row.microsite_id IS NOT NULL THEN
    SELECT
      m.id,
      m.tenant_id,
      m.path_prefix,
      m.is_active
    INTO microsite_row
    FROM public.microsite AS m
    WHERE m.id = initial_page_row.microsite_id
      AND m.tenant_id = p_tenant_id
    FOR UPDATE;
    microsite_found := FOUND;
  END IF;

  /*
   * The canonical page is now locked/reread.  A page reassignment, tenant
   * move, FK action, or delete that won the race is a stale snapshot and must
   * not reach the source-parent CAS.
   */
  SELECT
    p.id,
    p.tenant_id,
    p.slug,
    p.microsite_id,
    p.builder_type
  INTO page_row
  FROM public.i_edit_page AS p
  WHERE p.id = p_source_id
    AND p.tenant_id = p_tenant_id
    AND p.builder_type = 'canvas'
  FOR UPDATE;
  locked_page_found := FOUND;
  IF page_found IS DISTINCT FROM locked_page_found THEN
    RETURN false;
  END IF;
  IF page_found
     AND (
       page_row.microsite_id IS DISTINCT FROM initial_page_row.microsite_id
       OR page_row.tenant_id IS DISTINCT FROM initial_page_row.tenant_id
     ) THEN
    RETURN false;
  END IF;
  page_found := locked_page_found;

  /*
   * Empty snapshots are tombstones and may legitimately follow a delete or
   * inactive microsite.  Nonempty rows, however, must describe the currently
   * routable page.  Returning false leaves the claim/CAS untouched; the
   * invalidation trigger or the next bounded worker pass will retry.
   */
  IF jsonb_array_length(p_rows) > 0 THEN
    IF NOT page_found THEN
      RETURN false;
    END IF;
    IF page_row.microsite_id IS DISTINCT FROM payload_microsite_id THEN
      RETURN false;
    END IF;
    IF page_row.microsite_id IS NULL THEN
      expected_link :=
        CASE WHEN page_row.slug IS NULL THEN NULL
                  ELSE '/' || public.microsite_member_content_uri_component(
                    page_row.slug
                  ) END;
    ELSE
      IF NOT microsite_found OR microsite_row.is_active IS NOT TRUE THEN
        RETURN false;
      END IF;
      expected_link :=
        CASE
          WHEN microsite_row.path_prefix IS NULL
               OR microsite_row.path_prefix = '' THEN
             CASE WHEN page_row.slug IS NULL THEN NULL
                  ELSE '/' || public.microsite_member_content_uri_component(
                    page_row.slug
                  ) END
          ELSE
             CASE WHEN page_row.slug IS NULL THEN NULL
                  ELSE
                    '/' || public.microsite_member_content_uri_component(
                      microsite_row.path_prefix
                    ) || '/' ||
                    public.microsite_member_content_uri_component(page_row.slug)
             END
        END;
    END IF;
    IF payload_link IS DISTINCT FROM expected_link THEN
      RETURN false;
    END IF;
  END IF;

  RETURN public.publish_member_content_repair_unfenced(
    p_tenant_id,
    p_content_type,
    p_source_id,
    p_generation,
    p_claim_token,
    p_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.publish_member_content_repair(
  uuid, text, uuid, bigint, uuid, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.publish_member_content_repair(
  uuid, text, uuid, bigint, uuid, jsonb
) TO service_role;

NOTIFY pgrst, 'reload schema';
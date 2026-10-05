-- PREPARED ONLY. Apply to the verified destination with explicit approval.
-- This migration supplies policy persistence and exact eligibility lookup.
-- It does NOT enable provisioning or introduce a member creation endpoint.
BEGIN;

-- Abort rather than silently rely on an unrelated index with the same name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'member_email_tenant_unique_ci_idx'
      AND i.indrelid = 'public.member'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid, 1, true) = 'tenant_id'
      AND pg_get_indexdef(i.indexrelid, 2, true) IN
        ('lower(TRIM(BOTH FROM email))', 'lower(btrim(email))')
  ) THEN
    RAISE EXCEPTION 'Verified tenant-normalized member email uniqueness is required; inspect indexes and historical duplicates manually';
  END IF;
END $$;

-- Match JavaScript String.trim(), not only SQL's default ASCII-space trim.
-- Existing indexes remain in place; conflicting historical rows abort this
-- migration for operator review rather than being merged or deleted.
CREATE OR REPLACE FUNCTION public.normalize_public_ticket_email(value text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path=pg_catalog
AS $$ SELECT lower(btrim(value, E' \t\n\r\f' || chr(11) ||
  U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) $$;
CREATE UNIQUE INDEX IF NOT EXISTS member_public_ticket_email_normalized_unique
  ON public.member(tenant_id, public.normalize_public_ticket_email(email));

ALTER TABLE public.complex_event_ticket_class
  ADD COLUMN IF NOT EXISTS create_member_records boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS new_member_role_id uuid;

-- Descriptive only: never populate organization_id from this field.
ALTER TABLE public.member
  ADD COLUMN IF NOT EXISTS supplied_organization_name text;

CREATE OR REPLACE FUNCTION public.lookup_public_ticket_member_emails(
  p_tenant_id uuid, p_emails text[]
) RETURNS TABLE(normalized_email text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_emails IS NULL
     OR cardinality(p_emails) < 1 OR cardinality(p_emails) > 101
     OR EXISTS (SELECT 1 FROM unnest(p_emails) AS e(value)
                WHERE e.value IS NULL OR btrim(e.value) = '' OR length(e.value) > 320)
  THEN
    RAISE EXCEPTION 'Invalid tenant or contact emails' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT public.normalize_public_ticket_email(m.email)
    FROM public.member AS m
    WHERE m.tenant_id = p_tenant_id
      AND public.normalize_public_ticket_email(m.email) = ANY (
        ARRAY(SELECT public.normalize_public_ticket_email(e.value) FROM unnest(p_emails) AS e(value))
      );
END $$;
REVOKE ALL ON FUNCTION public.lookup_public_ticket_member_emails(uuid, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_public_ticket_member_emails(uuid, text[])
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

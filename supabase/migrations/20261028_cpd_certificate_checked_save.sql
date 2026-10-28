-- A separately named entry point makes older databases fail before any write.
-- Verify persistence inside the same transaction, so stale inner functions
-- cannot report success while dropping configuration.
BEGIN;
CREATE OR REPLACE FUNCTION public.save_cpd_certificate_template_checked(
  p_template_id uuid, p_tenant_id uuid, p_expected_version integer,
  p_name text, p_description text, p_placeholders jsonb, p_actor text
) RETURNS public.cpd_certificate_template
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  saved public.cpd_certificate_template;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cpd_certificate_placeholder'
      AND column_name = 'text_template') THEN
    RAISE EXCEPTION 'cpd_text_schema_incompatible' USING ERRCODE = 'P0001';
  END IF;
  saved := public.save_cpd_certificate_template(p_template_id, p_tenant_id,
    p_expected_version, p_name, p_description, p_placeholders, p_actor);
  IF EXISTS (
    WITH expected AS (
      SELECT f->>'placeholder_key' AS key, f->>'text_template' AS text
      FROM jsonb_array_elements(p_placeholders) f
    ), actual AS (
      SELECT p.placeholder_key AS key, to_jsonb(p)->>'text_template' AS text
      FROM public.cpd_certificate_placeholder p
      WHERE p.template_id = p_template_id AND p.tenant_id = p_tenant_id
    )
    (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
  ) THEN
    RAISE EXCEPTION 'cpd_text_schema_incompatible' USING ERRCODE = 'P0001';
  END IF;
  RETURN saved;
END;
$$;
REVOKE ALL ON FUNCTION public.save_cpd_certificate_template_checked(uuid,uuid,integer,text,text,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_cpd_certificate_template_checked(uuid,uuid,integer,text,text,jsonb,text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;

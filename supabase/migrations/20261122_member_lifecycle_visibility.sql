BEGIN;
CREATE OR REPLACE FUNCTION public.member_lifecycle_closed_addresses(p_tenant uuid,p_emails text[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT COALESCE(jsonb_agg(address),'[]'::jsonb) FROM (
    SELECT DISTINCT lower(btrim(email)) address FROM public.member
    WHERE tenant_id=p_tenant AND lower(btrim(email))=ANY(p_emails[1:200])
      AND lifecycle_state IN ('archived','minimised','deleted')
  ) closed
$$;
REVOKE ALL ON FUNCTION public.member_lifecycle_closed_addresses(uuid,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_lifecycle_closed_addresses(uuid,text[]) TO service_role;
DO $$
BEGIN
  IF to_regprocedure('public.member_lifecycle_base_alphabet_predicate(jsonb,text)') IS NULL THEN
    IF to_regprocedure('public.crm_alphabet_predicate(jsonb,text)') IS NULL THEN
      RAISE EXCEPTION 'CRM alphabet metadata prerequisite is missing';
    END IF;
    ALTER FUNCTION public.crm_alphabet_predicate(jsonb,text) RENAME TO member_lifecycle_base_alphabet_predicate;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.crm_alphabet_predicate(p_node jsonb,p_alias text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_node->>'column'='lifecycle_state' THEN
    IF p_alias<>'r' OR p_node->>'op'<>'in' OR (p_node->>'negate')::boolean IS DISTINCT FROM true
      OR p_node->'value' IS DISTINCT FROM '["archived","minimised","deleted"]'::jsonb THEN
      RAISE EXCEPTION 'Invalid lifecycle visibility filter';
    END IF;
    RETURN 'r.lifecycle_state NOT IN (''archived'',''minimised'',''deleted'')';
  END IF;
  RETURN public.member_lifecycle_base_alphabet_predicate(p_node,p_alias);
END $$;
REVOKE ALL ON FUNCTION public.crm_alphabet_predicate(jsonb,text),
  public.member_lifecycle_base_alphabet_predicate(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.member_lifecycle_operational_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM pg_attribute
    WHERE attrelid='public.member'::regclass AND attname='lifecycle_state' AND NOT attisdropped)
$$;
REVOKE ALL ON FUNCTION public.member_lifecycle_operational_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_lifecycle_operational_ready() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

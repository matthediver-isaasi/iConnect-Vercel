-- Atomic list copy: retain consent provenance, never campaigns or send history.
CREATE OR REPLACE FUNCTION public.duplicate_audience_list(
  p_tenant_id uuid, p_source_id uuid, p_name text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  source_list public.audience_list%ROWTYPE;
  new_id uuid;
BEGIN
  IF p_tenant_id IS NULL OR p_name IS NULL OR btrim(p_name) = '' OR length(btrim(p_name)) > 200 THEN
    RAISE EXCEPTION 'Invalid list name or tenant' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO source_list FROM public.audience_list
    WHERE id = p_source_id AND tenant_id = p_tenant_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audience list not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.audience_list(tenant_id, name, communication_category_id, target_audiences, ignore_opt_outs,
    category_review_required, category_review_reason)
    VALUES(p_tenant_id, btrim(p_name), source_list.communication_category_id,
      source_list.target_audiences, source_list.ignore_opt_outs,
      source_list.category_review_required, source_list.category_review_reason)
    RETURNING id INTO new_id;
  INSERT INTO public.audience_list_external_contact(
    tenant_id, audience_list_id, email, normalized_email, first_name, last_name,
    addition_source, gdpr_acknowledged, gdpr_acknowledged_at,
    added_by_tenant_user_id, added_by_member_id, added_by_actor_label, created_at
  )
  SELECT tenant_id, new_id, email, normalized_email, first_name, last_name,
    addition_source, gdpr_acknowledged, gdpr_acknowledged_at,
    added_by_tenant_user_id, added_by_member_id, added_by_actor_label, created_at
  FROM public.audience_list_external_contact
  WHERE tenant_id = p_tenant_id AND audience_list_id = p_source_id;
  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION public.duplicate_audience_list(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.duplicate_audience_list(uuid, uuid, text) TO service_role;

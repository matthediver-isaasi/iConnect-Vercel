-- Task 4600. Pending: do not apply without migration approval.
ALTER TABLE public.email_campaign
  ADD COLUMN IF NOT EXISTS category_review_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS category_review_reason jsonb,
  ADD COLUMN IF NOT EXISTS category_review_marked_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_category_id uuid,
  ADD COLUMN IF NOT EXISTS deleted_category_name text;
ALTER TABLE public.audience_list
  ADD COLUMN IF NOT EXISTS category_review_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS category_review_reason jsonb;
ALTER TABLE public.member_transactional_message
  ADD COLUMN IF NOT EXISTS deleted_category_name text;

CREATE OR REPLACE FUNCTION public.delete_communication_category_preserving_campaigns(
  p_tenant_id uuid, p_category_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_category public.communication_category%ROWTYPE;
  v_active text; v_campaigns int:=0; v_reviews int:=0;
  v_prefs int:=0; v_subscribers int:=0; v_unsubscribes int:=0;
BEGIN
  IF p_tenant_id IS NULL OR p_category_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Tenant and category are required';
  END IF;
  SELECT * INTO v_category FROM public.communication_category
    WHERE id=p_category_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Communication category not found'; END IF;

  CREATE TEMP TABLE task4600_forms(id uuid PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO task4600_forms SELECT id FROM public.form
    WHERE tenant_id=p_tenant_id AND communication_category_id=p_category_id;
  CREATE TEMP TABLE task4600_lists(id uuid PRIMARY KEY) ON COMMIT DROP;
  WITH RECURSIVE affected(id) AS (
    SELECT l.id FROM public.audience_list l WHERE l.tenant_id=p_tenant_id AND (
      l.communication_category_id=p_category_id OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(l.target_audiences,'[]')) s
        WHERE (s->>'type'='communication_category' AND COALESCE(s->'ids','[]') ? p_category_id::text)
           OR (s->>'type' IN ('form','event_form') AND EXISTS (
             SELECT 1 FROM task4600_forms f WHERE COALESCE(s->'ids','[]') ? f.id::text))))
    UNION
    SELECT p.id FROM public.audience_list p JOIN affected child ON EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p.target_audiences,'[]')) s
      WHERE s->>'type'='audience_list' AND COALESCE(s->'ids','[]') ? child.id::text)
    WHERE p.tenant_id=p_tenant_id
  ) INSERT INTO task4600_lists SELECT DISTINCT id FROM affected;

  CREATE TEMP TABLE task4600_campaigns(id uuid PRIMARY KEY,direct boolean NOT NULL) ON COMMIT DROP;
  INSERT INTO task4600_campaigns
  SELECT c.id,COALESCE(c.communication_category_id=p_category_id,false)
  FROM public.email_campaign c WHERE c.tenant_id=p_tenant_id AND (
    c.communication_category_id=p_category_id
    OR (c.target_type='communication_category' AND p_category_id::text=ANY(COALESCE(c.target_ids::text[],'{}'::text[])))
    OR (c.target_type IN ('form','event_form') AND EXISTS (
      SELECT 1 FROM task4600_forms f WHERE f.id::text=ANY(COALESCE(c.target_ids::text[],'{}'::text[]))))
    OR (c.target_type='audience_list' AND EXISTS (
      SELECT 1 FROM task4600_lists l WHERE l.id::text=ANY(COALESCE(c.target_ids::text[],'{}'::text[]))))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(c.target_audiences,'[]')) s WHERE
      (s->>'type'='communication_category' AND COALESCE(s->'ids','[]') ? p_category_id::text)
      OR (s->>'type' IN ('form','event_form') AND EXISTS (
        SELECT 1 FROM task4600_forms f WHERE COALESCE(s->'ids','[]') ? f.id::text))
      OR (s->>'type'='audience_list' AND EXISTS (
        SELECT 1 FROM task4600_lists l WHERE COALESCE(s->'ids','[]') ? l.id::text))));

  PERFORM c.id FROM public.email_campaign c JOIN task4600_campaigns a USING(id)
    ORDER BY c.id FOR UPDATE OF c;
  SELECT c.name INTO v_active FROM public.email_campaign c JOIN task4600_campaigns a USING(id)
    WHERE c.status IN ('preparing','sending','processing') LIMIT 1;
  IF v_active IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='55P03',
    MESSAGE='Category is in use by an active campaign',DETAIL=v_active,
    HINT='Retry after active delivery has finished or been cancelled'; END IF;
  SELECT count(*) INTO v_campaigns FROM task4600_campaigns;
  SELECT count(*) INTO v_reviews FROM task4600_campaigns;

  UPDATE public.email_campaign c SET communication_category_id=NULL,
    deleted_category_id=p_category_id,deleted_category_name=v_category.name,
    category_review_required=true,
    category_review_reason=jsonb_build_object(
      'code','deleted_communication_category','categoryId',p_category_id,'categoryName',v_category.name,
      'directCategory',a.direct,'requiresAudienceAndCategoryConfirmation',true),
    category_review_marked_at=now(),
    status=CASE WHEN c.status='scheduled' THEN 'draft' ELSE c.status END,
    scheduled_at=CASE WHEN c.status='scheduled' THEN NULL ELSE c.scheduled_at END,updated_at=now()
  FROM task4600_campaigns a WHERE c.id=a.id;
  DELETE FROM public.email_subscriber WHERE tenant_id=p_tenant_id AND communication_category_id=p_category_id;
  GET DIAGNOSTICS v_subscribers=ROW_COUNT;
  DELETE FROM public.email_unsubscribe WHERE tenant_id=p_tenant_id AND communication_category_id=p_category_id;
  GET DIAGNOSTICS v_unsubscribes=ROW_COUNT;
  DELETE FROM public.member_communication_preference WHERE tenant_id=p_tenant_id AND category_id=p_category_id;
  GET DIAGNOSTICS v_prefs=ROW_COUNT;
  DELETE FROM public.communication_category_role WHERE tenant_id=p_tenant_id AND category_id=p_category_id;
  UPDATE public.form SET communication_category_id=NULL
    WHERE tenant_id=p_tenant_id AND communication_category_id=p_category_id;
  UPDATE public.audience_list l SET
    communication_category_id=CASE WHEN l.communication_category_id=p_category_id THEN NULL ELSE l.communication_category_id END,
    category_review_required=true,category_review_reason=jsonb_build_object(
      'code','deleted_communication_category','categoryId',p_category_id,'categoryName',v_category.name),updated_at=now()
    WHERE l.tenant_id=p_tenant_id AND EXISTS(SELECT 1 FROM task4600_lists a WHERE a.id=l.id);
  UPDATE public.member_transactional_message SET communication_category_id=NULL,
    deleted_category_name=v_category.name,updated_at=now()
    WHERE tenant_id=p_tenant_id AND communication_category_id=p_category_id;
  DELETE FROM public.communication_category WHERE id=p_category_id AND tenant_id=p_tenant_id;
  RETURN jsonb_build_object('success',true,'categoryId',p_category_id,'categoryName',v_category.name,
    'affectedCampaignCount',v_campaigns,'reviewRequiredCampaignCount',v_reviews,
    'removedMemberPreferenceCount',v_prefs,'removedSubscriberCount',v_subscribers,
    'removedCategoryUnsubscribeCount',v_unsubscribes);
END $$;

CREATE OR REPLACE FUNCTION public.clear_email_campaign_category_review(
  p_tenant_id uuid,p_campaign_id uuid
) RETURNS public.email_campaign LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.email_campaign%ROWTYPE; deleted_id text; bad boolean;
BEGIN
  SELECT * INTO c FROM public.email_campaign WHERE id=p_campaign_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Campaign not found'; END IF;
  IF NOT c.category_review_required THEN RETURN c; END IF;
  IF c.status IN ('preparing','sending','processing') THEN
    RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='Active campaign cannot be reconfigured'; END IF;
  deleted_id:=c.category_review_reason->>'categoryId';
  IF c.communication_category_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.communication_category x
    WHERE x.id=c.communication_category_id AND x.tenant_id=p_tenant_id) THEN
    RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Select a valid communication category'; END IF;
  IF deleted_id IS NOT NULL AND (
    (c.target_type='communication_category' AND deleted_id=ANY(COALESCE(c.target_ids::text[],'{}'::text[])))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(c.target_audiences,'[]')) s
      WHERE s->>'type'='communication_category' AND COALESCE(s->'ids','[]') ? deleted_id)) THEN
    RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Replace the deleted communication category in campaign targeting'; END IF;
  IF c.target_type IN ('form','event_form') AND EXISTS(SELECT 1 FROM unnest(COALESCE(c.target_ids::text[],'{}'::text[])) t(id)
    WHERE NOT EXISTS(SELECT 1 FROM public.form f WHERE f.id::text=t.id AND f.tenant_id=p_tenant_id
      AND f.communication_category_id IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Replace forms whose communication category was deleted'; END IF;
  IF c.target_type='audience_list' AND EXISTS(SELECT 1 FROM unnest(COALESCE(c.target_ids::text[],'{}'::text[])) t(id)
    WHERE NOT EXISTS(SELECT 1 FROM public.audience_list l WHERE l.id::text=t.id AND l.tenant_id=p_tenant_id
      AND l.category_review_required=false)) THEN
    RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Replace audience lists affected by the deleted category'; END IF;
  WITH RECURSIVE lists(id) AS (
    SELECT unnest(COALESCE(c.target_ids::text[],'{}'::text[]))::uuid WHERE c.target_type='audience_list'
    UNION SELECT x.value::uuid FROM jsonb_array_elements(COALESCE(c.target_audiences,'[]')) s,
      jsonb_array_elements_text(COALESCE(s->'ids','[]')) x WHERE s->>'type'='audience_list'
    UNION SELECT x.value::uuid FROM public.audience_list l JOIN lists z ON z.id=l.id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.target_audiences,'[]')) s
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(s->'ids','[]')) x
      WHERE l.tenant_id=p_tenant_id AND s->>'type'='audience_list'),
  seg AS (SELECT s FROM jsonb_array_elements(COALESCE(c.target_audiences,'[]')) s UNION ALL
    SELECT s FROM public.audience_list l JOIN lists z ON z.id=l.id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.target_audiences,'[]')) s WHERE l.tenant_id=p_tenant_id)
  SELECT EXISTS(SELECT 1 FROM seg s WHERE
    (s->>'type'='communication_category' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(s->'ids','[]')) x
      WHERE NOT EXISTS(SELECT 1 FROM public.communication_category q WHERE q.id=x.value::uuid AND q.tenant_id=p_tenant_id)))
    OR (s->>'type' IN ('form','event_form') AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(s->'ids','[]')) x
      WHERE NOT EXISTS(SELECT 1 FROM public.form f WHERE f.id=x.value::uuid AND f.tenant_id=p_tenant_id AND f.communication_category_id IS NOT NULL)))
    OR (s->>'type'='audience_list' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(s->'ids','[]')) x
      WHERE NOT EXISTS(SELECT 1 FROM public.audience_list l WHERE l.id=x.value::uuid AND l.tenant_id=p_tenant_id AND l.category_review_required=false)))
  ) INTO bad;
  IF bad THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Replace deleted category references in forms or audience lists'; END IF;
  UPDATE public.email_campaign SET category_review_required=false,category_review_reason=NULL,
    category_review_marked_at=NULL,updated_at=now() WHERE id=p_campaign_id AND tenant_id=p_tenant_id RETURNING * INTO c;
  RETURN c;
END $$;

REVOKE ALL ON FUNCTION public.delete_communication_category_preserving_campaigns(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.clear_email_campaign_category_review(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.delete_communication_category_preserving_campaigns(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_email_campaign_category_review(uuid,uuid) TO service_role;
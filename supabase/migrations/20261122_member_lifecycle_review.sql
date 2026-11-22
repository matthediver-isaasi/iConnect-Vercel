-- Non-destructive review decisions. No role/access/profile mutation.
BEGIN;
CREATE TABLE IF NOT EXISTS public.member_lifecycle_record (
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','former','guest','archived','minimised','deleted')),
  hold boolean NOT NULL DEFAULT false,
  exempt boolean NOT NULL DEFAULT false,
  review_after date,
  archived_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,member_id)
);
CREATE TABLE IF NOT EXISTS public.member_lifecycle_record_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  revision bigint NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,member_id,revision)
);
ALTER TABLE public.member_lifecycle_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_lifecycle_record_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_lifecycle_record,public.member_lifecycle_record_audit
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_lifecycle_record,public.member_lifecycle_record_audit TO service_role;
DROP POLICY IF EXISTS lifecycle_record_service_read ON public.member_lifecycle_record;
CREATE POLICY lifecycle_record_service_read ON public.member_lifecycle_record FOR SELECT TO service_role USING(true);
DROP POLICY IF EXISTS lifecycle_record_audit_service_read ON public.member_lifecycle_record_audit;
CREATE POLICY lifecycle_record_audit_service_read ON public.member_lifecycle_record_audit FOR SELECT TO service_role USING(true);

CREATE OR REPLACE FUNCTION public.member_lifecycle_record_decision(
  p_tenant_id uuid,p_member_id uuid,p_revision bigint,p_action text,
  p_reason text,p_actor text,p_review_after date DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_record public.member_lifecycle_record; v_before jsonb; v_zone text;
BEGIN
  IF p_tenant_id IS NULL OR p_member_id IS NULL OR p_revision IS NULL OR p_revision<0
    OR p_action IS NULL OR p_action NOT IN ('retain','release_hold','extend','exempt','clear_exemption')
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000
    OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid lifecycle decision' USING ERRCODE='22023';
  END IF;
  -- Never accept the browser's tenant, record ownership or audit identity.
  IF NOT EXISTS(SELECT 1 FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id
    WHERE m.id=p_member_id AND COALESCE(m.tenant_id,o.tenant_id)=p_tenant_id) THEN
    RAISE EXCEPTION 'Member unavailable in this tenant' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('member-lifecycle-record:'||p_tenant_id||':'||p_member_id,0));
  INSERT INTO public.member_lifecycle_record(tenant_id,member_id)
    VALUES(p_tenant_id,p_member_id) ON CONFLICT DO NOTHING;
  SELECT * INTO v_record FROM public.member_lifecycle_record
    WHERE tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
  IF v_record.revision<>p_revision THEN
    RAISE EXCEPTION 'Member review changed; reload before deciding' USING ERRCODE='PT409';
  END IF;
  IF v_record.state='deleted' THEN
    RAISE EXCEPTION 'Deleted records cannot be changed' USING ERRCODE='PT409';
  END IF;
  v_before:=to_jsonb(v_record)-'updated_at';
  CASE p_action
    WHEN 'retain' THEN v_record.hold:=true;
    WHEN 'release_hold' THEN v_record.hold:=false;
    WHEN 'exempt' THEN v_record.exempt:=true;
    WHEN 'clear_exemption' THEN v_record.exempt:=false;
    WHEN 'extend' THEN
      SELECT COALESCE(policy->>'timezone','UTC') INTO v_zone
        FROM public.member_lifecycle_policy WHERE tenant_id=p_tenant_id;
      IF p_review_after IS NULL OR p_review_after<=(now() AT TIME ZONE COALESCE(v_zone,'UTC'))::date THEN
        RAISE EXCEPTION 'Choose a future review date' USING ERRCODE='22023';
      END IF;
      IF v_record.review_after IS NOT NULL AND p_review_after<v_record.review_after THEN
        RAISE EXCEPTION 'An extension cannot shorten existing retention' USING ERRCODE='22023';
      END IF;
      v_record.review_after:=p_review_after;
  END CASE;
  UPDATE public.member_lifecycle_record SET hold=v_record.hold,exempt=v_record.exempt,
    review_after=v_record.review_after,revision=revision+1,updated_at=now()
    WHERE tenant_id=p_tenant_id AND member_id=p_member_id RETURNING * INTO v_record;
  INSERT INTO public.member_lifecycle_record_audit(
    tenant_id,member_id,revision,action,reason,actor,before_state,after_state)
    VALUES(p_tenant_id,p_member_id,v_record.revision,p_action,btrim(p_reason),p_actor,
      v_before,to_jsonb(v_record)-'updated_at');
  RETURN to_jsonb(v_record);
END $$;
REVOKE ALL ON FUNCTION public.member_lifecycle_record_decision(uuid,uuid,bigint,text,text,text,date)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_lifecycle_record_decision(uuid,uuid,bigint,text,text,text,date) TO service_role;

CREATE OR REPLACE FUNCTION public.member_lifecycle_review_page(p_tenant_id uuid,p_cursor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH candidates AS (
    SELECT member_id FROM public.member_lifecycle_record WHERE tenant_id=p_tenant_id
    UNION
    SELECT i.member_id FROM public.member_lifecycle_preview_item i
      JOIN public.member_lifecycle_preview p ON p.id=i.preview_id AND p.tenant_id=i.tenant_id
      JOIN public.member_lifecycle_policy config ON config.tenant_id=p.tenant_id AND config.revision=p.policy_revision
      WHERE i.tenant_id=p_tenant_id AND i.proposal->>'action' IN ('evidence_review','deletion_review','archive','former','guest')
  ), page AS (
    SELECT c.member_id FROM candidates c JOIN public.member m ON m.id=c.member_id
      LEFT JOIN public.organization o ON o.id=m.organization_id
      WHERE COALESCE(m.tenant_id,o.tenant_id)=p_tenant_id
        AND (p_cursor IS NULL OR c.member_id>p_cursor)
      ORDER BY c.member_id LIMIT 51
  ), items AS (
    SELECT p.member_id,
      jsonb_build_object('memberId',p.member_id,'state',COALESCE(r.state,'active'),
        'revision',COALESCE(r.revision,0),'hold',COALESCE(r.hold,false),'exempt',COALESCE(r.exempt,false),
        'reviewAfter',r.review_after,'reason',COALESCE(latest.proposal->>'reason','administrator_review'),
        'eligibleOn',latest.proposal->>'eligibleOn') AS item
    FROM (SELECT * FROM page ORDER BY member_id LIMIT 50) p
    LEFT JOIN public.member_lifecycle_record r ON r.tenant_id=p_tenant_id AND r.member_id=p.member_id
    LEFT JOIN LATERAL (
      SELECT i.proposal FROM public.member_lifecycle_preview_item i
      JOIN public.member_lifecycle_preview v ON v.id=i.preview_id AND v.tenant_id=i.tenant_id
      JOIN public.member_lifecycle_policy config ON config.tenant_id=v.tenant_id AND config.revision=v.policy_revision
      WHERE i.tenant_id=p_tenant_id AND i.member_id=p.member_id ORDER BY v.created_at DESC,v.id DESC LIMIT 1
    ) latest ON true
  )
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(item ORDER BY member_id) FROM items),'[]'::jsonb),
    'nextCursor',CASE WHEN (SELECT count(*) FROM page)>50 THEN (SELECT member_id FROM items ORDER BY member_id DESC LIMIT 1) END);
$$;
REVOKE ALL ON FUNCTION public.member_lifecycle_review_page(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_lifecycle_review_page(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

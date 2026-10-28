BEGIN;
CREATE TABLE public.member_change_request(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,member_id uuid NOT NULL,
 form_id uuid NOT NULL,source_record_id uuid NOT NULL,
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
 authority jsonb NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','withdrawn')),
 authority_id uuid REFERENCES public.member_change_authority(id),reviewed_by uuid,review_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz,
 UNIQUE(tenant_id,member_id,request_key),
 CHECK((state='approved')=(authority_id IS NOT NULL))
);
CREATE UNIQUE INDEX member_change_request_pending ON public.member_change_request(tenant_id,source_record_id) WHERE state='pending';
CREATE TABLE public.member_change_request_event(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,
 request_id uuid NOT NULL REFERENCES public.member_change_request(id),actor_id uuid NOT NULL,
 kind text NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_change_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_change_request_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_change_request,public.member_change_request_event FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_change_request,public.member_change_request_event TO service_role;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.member_change_request_event
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();
CREATE FUNCTION public.submit_member_change_request(
 p_tenant_id uuid,p_member_id uuid,p_form_id uuid,p_key text,p_authority jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_change_request; settings public.membership_change_form; source public.member_membership_history;
BEGIN
 PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Member unavailable'; END IF;
 SELECT * INTO r FROM public.member_change_request WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND request_key=p_key;
 IF FOUND THEN
  IF r.authority IS DISTINCT FROM p_authority OR r.form_id<>p_form_id THEN RAISE EXCEPTION 'Request key belongs to another selection'; END IF;
  RETURN to_jsonb(r);
 END IF;
 PERFORM 1 FROM public.form f WHERE id=p_form_id AND tenant_id=p_tenant_id
  AND is_active=true AND require_authentication=true
  AND (COALESCE(to_jsonb(f)->>'deactivate_at','')='' OR (to_jsonb(f)->>'deactivate_at')::timestamptz>now()) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Membership-change form unavailable'; END IF;
 SELECT * INTO settings FROM public.membership_change_form WHERE tenant_id=p_tenant_id AND form_id=p_form_id FOR SHARE;
 IF NOT FOUND OR NOT settings.enabled OR p_authority->'formBinding'->>'revision' IS DISTINCT FROM settings.revision::text
  OR p_authority->'formBinding'->>'formId' IS DISTINCT FROM p_form_id::text
  OR NOT COALESCE((p_authority->'request'->>'configId')::uuid=ANY(settings.target_config_ids),false)
  OR NOT EXISTS(SELECT 1 FROM public.form WHERE id=p_form_id AND tenant_id=p_tenant_id AND is_active=true AND require_authentication=true)
 THEN RAISE EXCEPTION 'Form configuration changed; refresh before submitting'; END IF;
 IF p_authority->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR p_authority->>'memberId' IS DISTINCT FROM p_member_id::text
  OR p_authority->>'action' IS DISTINCT FROM 'change' OR p_authority->'fundingEvidence'->>'complete' IS DISTINCT FROM 'true'
  OR p_authority->'calculation'->>'entitlementApplied' IS DISTINCT FROM 'false'
 THEN RAISE EXCEPTION 'Verified member change evidence required'; END IF;
 SELECT * INTO source FROM public.member_membership_history WHERE id=(p_authority->'sourceSnapshot'->>'id')::uuid
  AND tenant_id=p_tenant_id AND member_id=p_member_id AND status='active'
  AND term_start_date<=CURRENT_DATE AND membership_renewal_date>CURRENT_DATE FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Current membership changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.member_change_authority WHERE tenant_id=p_tenant_id AND source_record_id=source.id)
 THEN RAISE EXCEPTION 'This purchase already has a confirmed change requiring review'; END IF;
 INSERT INTO public.member_change_request(tenant_id,member_id,form_id,source_record_id,request_key,authority)
 VALUES(p_tenant_id,p_member_id,p_form_id,source.id,p_key,p_authority) RETURNING * INTO r;
 INSERT INTO public.member_change_request_event(tenant_id,request_id,actor_id,kind,evidence)
 VALUES(p_tenant_id,r.id,p_member_id,'submitted',jsonb_build_object('formId',p_form_id));
 RETURN to_jsonb(r);
END $$;
CREATE FUNCTION public.review_member_change_request(
 p_tenant_id uuid,p_member_id uuid,p_actor_id uuid,p_id uuid,p_action text,p_reason text,p_authority jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_change_request; confirmed jsonb;
BEGIN
 IF p_actor_id IS NULL OR p_action NOT IN ('approve','reject','withdraw')
  OR length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 1 AND 2000
  OR (p_action='withdraw' AND p_actor_id<>p_member_id) THEN RAISE EXCEPTION 'Audited review required'; END IF;
 PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Member unavailable'; END IF;
 SELECT * INTO r FROM public.member_change_request WHERE id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Request unavailable'; END IF;
 IF r.state<>'pending' THEN
  IF (r.state='approved' AND p_action='approve') OR (r.state='withdrawn' AND p_action='withdraw')
   OR (r.state='rejected' AND p_action='reject') THEN RETURN to_jsonb(r); END IF;
  RAISE EXCEPTION 'Request already reviewed';
 END IF;
 IF p_action='approve' THEN
  IF p_authority IS NULL OR (r.authority-'formBinding') IS DISTINCT FROM (p_authority-'formBinding')
   OR (p_authority->'calculation'->>'effectiveDate')::date IS DISTINCT FROM CURRENT_DATE
  THEN RAISE EXCEPTION 'Financial evidence changed; the member must refresh the request'; END IF;
  confirmed:=public.confirm_member_change_authority(p_tenant_id,p_member_id,p_actor_id,'admin','request:'||r.id::text,p_authority-'formBinding');
 END IF;
 UPDATE public.member_change_request SET state=CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'withdrawn' END,
  authority_id=CASE WHEN p_action='approve' THEN (confirmed->>'id')::uuid ELSE NULL END,
  reviewed_by=p_actor_id,review_reason=btrim(p_reason),reviewed_at=now() WHERE id=r.id RETURNING * INTO r;
 INSERT INTO public.member_change_request_event(tenant_id,request_id,actor_id,kind,evidence)
 VALUES(p_tenant_id,r.id,p_actor_id,r.state,jsonb_build_object('reason',p_reason,'authorityId',r.authority_id));
 RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION public.submit_member_change_request(uuid,uuid,uuid,text,jsonb),
 public.review_member_change_request(uuid,uuid,uuid,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.submit_member_change_request(uuid,uuid,uuid,text,jsonb),
 public.review_member_change_request(uuid,uuid,uuid,uuid,text,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

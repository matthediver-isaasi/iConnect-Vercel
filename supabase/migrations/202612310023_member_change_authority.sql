-- Step 1 only. Immutable confirmation authority; no settlement or entitlement.
BEGIN;
CREATE TABLE public.member_change_authority (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 source_record_id uuid NOT NULL REFERENCES public.member_membership_history(id),
 actor_id uuid NOT NULL,
 actor_kind text NOT NULL CHECK(actor_kind IN ('admin','member')),
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
 authority jsonb NOT NULL CHECK(jsonb_typeof(authority)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,member_id,request_key),
 UNIQUE(tenant_id,source_record_id)
);
ALTER TABLE public.member_change_authority ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_change_authority FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_change_authority TO service_role;
CREATE FUNCTION public.reject_member_change_authority_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Confirmed membership change authority is immutable'; END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.member_change_authority
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();

CREATE FUNCTION public.confirm_member_change_authority(
 p_tenant_id uuid,p_member_id uuid,p_actor_id uuid,p_actor_kind text,p_key text,p_authority jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE saved public.member_change_authority; source jsonb; target jsonb; policy jsonb;
BEGIN
 IF p_actor_id IS NULL OR p_actor_kind NOT IN ('admin','member') OR p_actor_kind IS NULL
   OR (p_actor_kind='member' AND p_actor_id<>p_member_id)
   OR p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 128
   OR p_authority->>'version' IS DISTINCT FROM '1'
   OR p_authority->>'tenantId' IS DISTINCT FROM p_tenant_id::text
   OR p_authority->>'memberId' IS DISTINCT FROM p_member_id::text
   OR COALESCE(p_authority->>'action','') NOT IN ('change','cancel')
   OR jsonb_typeof(p_authority->'calculation') IS DISTINCT FROM 'object'
   OR jsonb_typeof(p_authority->'settlement') IS DISTINCT FROM 'object'
   OR jsonb_typeof(p_authority->'fundingEvidence') IS DISTINCT FROM 'object'
   OR p_authority->'fundingEvidence'->>'complete' IS DISTINCT FROM 'true'
   OR p_authority->'fundingEvidence'->>'sourceRecordId' IS DISTINCT FROM p_authority->'sourceSnapshot'->>'id'
   OR p_authority->'calculation'->>'sourceRecordId' IS DISTINCT FROM p_authority->'sourceSnapshot'->>'id'
   OR p_authority->'calculation'->>'action' IS DISTINCT FROM p_authority->>'action'
   OR p_authority->'calculation'->>'effectiveDate' IS NULL
   OR p_authority->'calculation'->>'entitlementApplied' IS DISTINCT FROM 'false'
   OR p_authority->'calculation'->>'settlementStatus' IS DISTINCT FROM 'not_started' THEN
   RAISE EXCEPTION 'Invalid change authority' USING ERRCODE='22023';
 END IF;
 -- The caller supplies authenticated actor context; browsers have no RPC grant.
 PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='40001'; END IF;
 SELECT * INTO saved FROM public.member_change_authority
   WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND request_key=p_key;
 IF FOUND THEN
   IF saved.authority IS DISTINCT FROM p_authority OR saved.actor_id<>p_actor_id
     OR saved.actor_kind<>p_actor_kind THEN
     RAISE EXCEPTION 'Confirmation key conflict' USING ERRCODE='40001';
   END IF;
   RETURN to_jsonb(saved);
 END IF;
 -- Serialize with first-save policy changes, including the absent-row case.
 PERFORM 1 FROM public.tenant WHERE id=p_tenant_id FOR UPDATE;
 SELECT to_jsonb(p) INTO policy FROM public.membership_change_policy p WHERE tenant_id=p_tenant_id;
 IF COALESCE(policy,'null'::jsonb) IS DISTINCT FROM p_authority->'policySnapshot' THEN
   RAISE EXCEPTION 'Policy changed; preview again' USING ERRCODE='40001';
 END IF;
 SELECT to_jsonb(h) INTO source FROM public.member_membership_history h
   WHERE h.id=(p_authority->'sourceSnapshot'->>'id')::uuid
     AND h.tenant_id=p_tenant_id AND h.member_id=p_member_id FOR UPDATE;
 IF source IS NULL OR source IS DISTINCT FROM p_authority->'sourceSnapshot'
   OR source->>'status' IS DISTINCT FROM 'active'
   OR source->>'term_start_date' IS NULL OR source->>'membership_renewal_date' IS NULL
   OR (source->>'term_start_date')::date>CURRENT_DATE
   OR (source->>'membership_renewal_date')::date<=CURRENT_DATE THEN
   RAISE EXCEPTION 'Current purchase changed; preview again' USING ERRCODE='40001';
 END IF;
 IF (p_authority->'calculation'->>'effectiveDate')::date<CURRENT_DATE
   OR (p_authority->'calculation'->>'effectiveDate')::date>=(source->>'membership_renewal_date')::date THEN
   RAISE EXCEPTION 'Effective date is outside the current term' USING ERRCODE='40001';
 END IF;
 IF (SELECT count(*) FROM public.member_membership_history h WHERE h.tenant_id=p_tenant_id
   AND h.member_id=p_member_id AND h.status='active' AND h.term_start_date<=CURRENT_DATE
   AND h.membership_renewal_date>CURRENT_DATE)<>1
   OR EXISTS(SELECT 1 FROM public.member_membership_amendment a
     WHERE a.tenant_id=p_tenant_id AND a.source_record_id=(source->>'id')::uuid) THEN
   RAISE EXCEPTION 'Competing membership authority requires review' USING ERRCODE='40001';
 END IF;
 IF p_authority->>'action'='change' THEN
   SELECT to_jsonb(c) INTO target FROM public.membership_tier_config c
     WHERE c.id=(p_authority->'targetSnapshot'->>'id')::uuid AND c.tenant_id=p_tenant_id FOR SHARE;
   IF target IS NULL OR target IS DISTINCT FROM p_authority->'targetSnapshot'
     OR target->>'structure_scope_type' IS DISTINCT FROM 'member'
     OR target->>'is_active' IS DISTINCT FROM 'true' THEN
     RAISE EXCEPTION 'Target changed; preview again' USING ERRCODE='40001';
   END IF;
 END IF;
 INSERT INTO public.member_change_authority(tenant_id,member_id,source_record_id,actor_id,actor_kind,request_key,authority)
 VALUES(p_tenant_id,p_member_id,(source->>'id')::uuid,p_actor_id,p_actor_kind,p_key,p_authority)
 RETURNING * INTO saved;
 RETURN to_jsonb(saved);
END $$;
-- Close the inverse race: legacy admin proposals must not bypass a confirmed
-- new authority. Both confirmation paths serialize on the same member.
CREATE FUNCTION public.guard_legacy_member_change_authority()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.member m JOIN public.member_membership_history h ON h.member_id=m.id
   WHERE h.id=NEW.source_record_id AND m.tenant_id=NEW.tenant_id FOR UPDATE OF m;
 IF EXISTS(SELECT 1 FROM public.member_change_authority a
   WHERE a.tenant_id=NEW.tenant_id AND a.source_record_id=NEW.source_record_id) THEN
   RAISE EXCEPTION 'A confirmed membership change already owns this purchase' USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_change_authority_conflict BEFORE INSERT ON public.member_membership_amendment
 FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_member_change_authority();
REVOKE ALL ON FUNCTION public.reject_member_change_authority_mutation(),
 public.guard_legacy_member_change_authority(),
 public.confirm_member_change_authority(uuid,uuid,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.confirm_member_change_authority(uuid,uuid,uuid,text,text,jsonb) TO service_role;
COMMIT;

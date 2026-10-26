-- Retained-term upfront execution bridge. No data backfill or provider writes.
-- Requires the existing amendment settlement/application RPCs and Step 1.
BEGIN;
CREATE TABLE public.member_change_execution (
 authority_id uuid PRIMARY KEY REFERENCES public.member_change_authority(id),
 amendment_id uuid NOT NULL UNIQUE REFERENCES public.member_membership_amendment(id) DEFERRABLE INITIALLY DEFERRED,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 approved_by uuid NOT NULL,
 approval_reason text NOT NULL CHECK(length(btrim(approval_reason)) BETWEEN 1 AND 2000),
 settlement_choice text NOT NULL CHECK(settlement_choice IN ('collect','refund','none')),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_change_execution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_change_execution FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_change_execution TO service_role;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.member_change_execution
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();

CREATE OR REPLACE FUNCTION public.guard_legacy_member_change_authority()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.member m JOIN public.member_membership_history h ON h.member_id=m.id
   WHERE h.id=NEW.source_record_id AND m.tenant_id=NEW.tenant_id FOR UPDATE OF m;
 IF EXISTS(SELECT 1 FROM public.member_change_authority a
   WHERE a.tenant_id=NEW.tenant_id AND a.source_record_id=NEW.source_record_id
   AND NOT EXISTS(SELECT 1 FROM public.member_change_execution e
     WHERE e.authority_id=a.id AND e.amendment_id=NEW.id
       AND e.tenant_id=a.tenant_id AND e.member_id=a.member_id)) THEN
   RAISE EXCEPTION 'A confirmed membership change already owns this purchase' USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.begin_member_change_execution(
 p_tenant_id uuid,p_member_id uuid,p_authority_id uuid,p_actor_id uuid,
 p_choice text,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.member_change_authority; e public.member_change_execution;
 q jsonb; c jsonb; source jsonb; mid uuid:=gen_random_uuid(); request jsonb;
BEGIN
 IF p_actor_id IS NULL OR length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 1 AND 2000 THEN
   RAISE EXCEPTION 'Explicit audited approval is required' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='40001'; END IF;
 SELECT * INTO a FROM public.member_change_authority
   WHERE id=p_authority_id AND tenant_id=p_tenant_id AND member_id=p_member_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Authority not found' USING ERRCODE='40001'; END IF;
 SELECT * INTO e FROM public.member_change_execution WHERE authority_id=a.id;
 IF FOUND THEN
   IF e.settlement_choice IS DISTINCT FROM p_choice THEN
     RAISE EXCEPTION 'Settlement choice is locked' USING ERRCODE='40001';
   END IF;
   RETURN to_jsonb(e);
 END IF;
 c:=a.authority->'calculation';
 IF a.authority->>'action' IS DISTINCT FROM 'change'
   OR c->>'behaviour' IS DISTINCT FROM 'retain_term'
   OR c->'blockers' IS DISTINCT FROM '[]'::jsonb
   OR c->>'entitlementApplied' IS DISTINCT FROM 'false'
   OR c->>'settlementStatus' IS DISTINCT FROM 'not_started'
   OR NOT public.member_amendment_operational_scope_supported(
     a.authority->'sourceSnapshot',a.authority->'targetSnapshot')
   OR (c->>'effectiveDate')::date IS DISTINCT FROM CURRENT_DATE THEN
   RAISE EXCEPTION 'Only current retained-term verified upfront changes can execute' USING ERRCODE='40001';
 END IF;
 IF NOT COALESCE(
   (p_choice='collect' AND (c->'delta'->>'grossMinor')::bigint>0)
   OR (p_choice='none' AND (c->'delta'->>'netMinor')::bigint=0 AND (c->'delta'->>'vatMinor')::bigint=0)
   OR (p_choice='refund' AND (c->'delta'->>'grossMinor')::bigint<0
     AND a.authority->'settlement'->>'surplusHandling' IN ('refund','approval')),false) THEN
   RAISE EXCEPTION 'Settlement does not match the confirmed policy; personal-credit issuance is not enabled' USING ERRCODE='40001';
 END IF;
 SELECT to_jsonb(h) INTO source FROM public.member_membership_history h
   WHERE h.id=a.source_record_id AND h.tenant_id=p_tenant_id AND h.member_id=p_member_id FOR UPDATE;
 IF source IS DISTINCT FROM a.authority->'sourceSnapshot' THEN
   RAISE EXCEPTION 'Purchase changed before execution' USING ERRCODE='40001';
 END IF;
 -- Translate only the retained-term subset into the existing, reader-supported
 -- application contract. Never feed replacement/cancellation calculations here.
 q:=jsonb_build_object(
   'version',1,'sourceRecordId',a.source_record_id,'sourceSnapshot',source,
   'targetSnapshot',a.authority->'pricingSnapshot','currency',c->>'currency',
   'effectiveDate',c->>'effectiveDate','originalFullTerm',c->'finance'->'original',
   'targetFullTerm',c->'targetFullPrice','originalRemaining',c->'unused',
   'targetRemaining',c->'newCost','delta',c->'delta',
   'fundingEvidence',a.authority->'fundingEvidence'->'providerEvidence',
   'term',jsonb_build_object('startDate',source->>'term_start_date',
     'endDate',source->>'term_end_date','renewalDate',source->>'membership_renewal_date',
     'anchorDate',source->>'term_anchor_date','durationMonths',source->'term_duration_months',
     'termKey',source->>'term_key'));
 request:=a.authority->'request';
 INSERT INTO public.member_change_execution(authority_id,amendment_id,tenant_id,member_id,approved_by,approval_reason,settlement_choice)
   VALUES(a.id,mid,p_tenant_id,p_member_id,p_actor_id,btrim(p_reason),p_choice) RETURNING * INTO e;
 INSERT INTO public.member_membership_amendment(id,tenant_id,member_id,source_record_id,actor_id,idempotency_key,request,quote,status)
   VALUES(mid,p_tenant_id,p_member_id,a.source_record_id,p_actor_id,'authority:'||a.id::text,request,q,
     CASE WHEN p_choice='none' THEN 'pending_application' ELSE 'pending_settlement' END);
 INSERT INTO public.member_membership_amendment_event(tenant_id,amendment_id,actor_id,kind,evidence)
   VALUES(p_tenant_id,mid,p_actor_id,'authority_approved',
     jsonb_build_object('authorityId',a.id,'reason',btrim(p_reason),'choice',p_choice));
 RETURN to_jsonb(e);
END $$;
REVOKE ALL ON FUNCTION public.begin_member_change_execution(uuid,uuid,uuid,uuid,text,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_member_change_execution(uuid,uuid,uuid,uuid,text,text) TO service_role;

-- Existing generic admin settlement actions must not change the approved rail.
CREATE FUNCTION public.guard_member_change_execution_choice()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.member_change_execution e WHERE e.amendment_id=NEW.amendment_id
   AND (e.tenant_id IS DISTINCT FROM NEW.tenant_id OR e.member_id IS DISTINCT FROM NEW.member_id
     OR e.settlement_choice IS DISTINCT FROM NEW.choice)) THEN
   RAISE EXCEPTION 'Settlement must use the approved execution choice' USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_change_execution_choice BEFORE INSERT OR UPDATE ON public.member_membership_amendment_settlement
 FOR EACH ROW EXECUTE FUNCTION public.guard_member_change_execution_choice();
CREATE FUNCTION public.pending_member_change_executions(p_limit integer DEFAULT 30)
RETURNS SETOF public.member_change_execution LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT e.* FROM public.member_change_execution e
 JOIN public.member_membership_amendment_settlement s ON s.amendment_id=e.amendment_id AND s.tenant_id=e.tenant_id
 LEFT JOIN public.member_membership_amendment_application a ON a.amendment_id=e.amendment_id
 WHERE a.amendment_id IS NULL AND s.state IN ('reserved','awaiting_payment','uncertain','settled')
   AND s.next_attempt_at<=now()
 ORDER BY s.next_attempt_at,e.authority_id LIMIT LEAST(GREATEST(p_limit,1),100)
$$;
REVOKE ALL ON FUNCTION public.guard_member_change_execution_choice(),
 public.pending_member_change_executions(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pending_member_change_executions(integer) TO service_role;
COMMIT;

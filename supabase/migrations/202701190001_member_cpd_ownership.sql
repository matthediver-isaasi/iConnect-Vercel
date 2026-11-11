-- Ledger evidence is never rewritten. Ownership is a finite snapshot of award
-- roots, not a member alias: later activity on a retained source stays there.
BEGIN;
CREATE TABLE IF NOT EXISTS public.member_cpd_merge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  source_id uuid NOT NULL REFERENCES public.member(id),
  target_id uuid NOT NULL REFERENCES public.member(id),
  actor_id uuid NOT NULL REFERENCES public.member(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  result jsonb NOT NULL,
  UNIQUE(tenant_id,source_id,target_id),
  CHECK(source_id<>target_id)
);
CREATE TABLE IF NOT EXISTS public.member_cpd_ownership (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  root_id uuid NOT NULL REFERENCES public.member_cpd_points_ledger(id),
  original_member_id uuid NOT NULL REFERENCES public.member(id),
  source_id uuid NOT NULL REFERENCES public.member(id),
  target_id uuid NOT NULL REFERENCES public.member(id),
  merge_id uuid NOT NULL REFERENCES public.member_cpd_merge(id),
  UNIQUE(merge_id,root_id)
);
CREATE INDEX IF NOT EXISTS member_cpd_ownership_root
  ON public.member_cpd_ownership(tenant_id,root_id,sequence DESC);
ALTER TABLE public.member_cpd_merge ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_cpd_ownership ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_cpd_merge,public.member_cpd_ownership FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_cpd_merge,public.member_cpd_ownership TO service_role;

CREATE OR REPLACE FUNCTION public.reject_cpd_ownership_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN RAISE EXCEPTION 'CPD ownership audit is immutable'; END $$;
DROP TRIGGER IF EXISTS immutable_cpd_merge ON public.member_cpd_merge;
CREATE TRIGGER immutable_cpd_merge BEFORE UPDATE OR DELETE ON public.member_cpd_merge
  FOR EACH ROW EXECUTE FUNCTION public.reject_cpd_ownership_mutation();
DROP TRIGGER IF EXISTS immutable_cpd_ownership ON public.member_cpd_ownership;
CREATE TRIGGER immutable_cpd_ownership BEFORE UPDATE OR DELETE ON public.member_cpd_ownership
  FOR EACH ROW EXECUTE FUNCTION public.reject_cpd_ownership_mutation();

CREATE OR REPLACE VIEW public.member_cpd_effective_ledger AS
SELECT l.*, COALESCE(o.target_id,l.member_id) AS effective_member_id
FROM public.member_cpd_points_ledger l
LEFT JOIN LATERAL (
  SELECT target_id FROM public.member_cpd_ownership o
  WHERE o.tenant_id=l.tenant_id AND o.root_id=COALESCE(l.reversal_of,l.correction_of,l.id)
  ORDER BY o.sequence DESC LIMIT 1
) o ON true;
REVOKE ALL ON public.member_cpd_effective_ledger FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.member_cpd_effective_ledger TO service_role;

-- Serialize transfers and ledger appends in a tenant. Linked entries inherit
-- their root's current owner without changing original-member provenance.
CREATE OR REPLACE FUNCTION public.serialize_cpd_ownership()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':cpd-ownership',0));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS serialize_cpd_ownership ON public.member_cpd_points_ledger;
CREATE TRIGGER serialize_cpd_ownership BEFORE INSERT ON public.member_cpd_points_ledger
  FOR EACH ROW EXECUTE FUNCTION public.serialize_cpd_ownership();

CREATE OR REPLACE FUNCTION public.transfer_member_cpd(
  p_tenant_id uuid,p_source_id uuid,p_target_id uuid,p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE prior public.member_cpd_merge%ROWTYPE; result jsonb; merge_id uuid:=gen_random_uuid();
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  IF p_source_id IS NULL OR p_target_id IS NULL OR p_source_id=p_target_id THEN
    RAISE EXCEPTION 'Different source and target members are required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':cpd-ownership',0));
  IF (SELECT count(*) FROM public.member WHERE tenant_id=p_tenant_id AND id IN(p_source_id,p_target_id))<>2
    OR NOT EXISTS(SELECT 1 FROM public.member WHERE tenant_id=p_tenant_id AND id=p_actor_id) THEN
    RAISE EXCEPTION 'CPD merge members and actor must belong to the tenant';
  END IF;
  SELECT * INTO prior FROM public.member_cpd_merge
    WHERE tenant_id=p_tenant_id AND source_id=p_source_id AND target_id=p_target_id;
  IF FOUND THEN RETURN prior.result||jsonb_build_object('alreadyApplied',true); END IF;
  IF EXISTS(SELECT 1 FROM public.member_cpd_merge WHERE tenant_id=p_tenant_id AND source_id=p_source_id)
    AND NOT EXISTS(SELECT 1 FROM public.member_cpd_effective_ledger
      WHERE tenant_id=p_tenant_id AND effective_member_id=p_source_id) THEN
    RAISE EXCEPTION 'Source CPD ownership was already transferred; retry the original merge';
  END IF;
  IF EXISTS(
    WITH RECURSIVE path(id) AS (
      SELECT p_target_id UNION
      SELECT m.target_id FROM public.member_cpd_merge m JOIN path p ON m.source_id=p.id
      WHERE m.tenant_id=p_tenant_id
    ) SELECT 1 FROM path WHERE id=p_source_id
  ) THEN RAISE EXCEPTION 'CPD ownership transfer would create a cycle'; END IF;
  SELECT jsonb_build_object('mergeId',merge_id,'historyCount',count(*),
    'balance',COALESCE(sum(points_value),0)::text,'alreadyApplied',false)
    INTO result FROM public.member_cpd_effective_ledger
    WHERE tenant_id=p_tenant_id AND effective_member_id=p_source_id;
  INSERT INTO public.member_cpd_merge(id,tenant_id,source_id,target_id,actor_id,result)
    VALUES(merge_id,p_tenant_id,p_source_id,p_target_id,p_actor_id,result);
  INSERT INTO public.member_cpd_ownership(tenant_id,root_id,original_member_id,source_id,target_id,merge_id)
    SELECT p_tenant_id,id,member_id,p_source_id,p_target_id,merge_id
    FROM public.member_cpd_effective_ledger
    WHERE tenant_id=p_tenant_id AND effective_member_id=p_source_id
      AND reversal_of IS NULL AND correction_of IS NULL;
  IF EXISTS(SELECT 1 FROM public.member_cpd_effective_ledger
    WHERE tenant_id=p_tenant_id AND effective_member_id=p_source_id) THEN
    RAISE EXCEPTION 'CPD transfer verification failed; source must not be disposed';
  END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.transfer_member_cpd(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_member_cpd(uuid,uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.reject_cpd_ownership_mutation(),public.serialize_cpd_ownership() FROM PUBLIC,anon,authenticated;

-- A previously earned occurrence remains earned after its source is
-- anonymised. Replay must resolve that existing award before attempting new
-- attendee matching. Never mint points or change the original attempt/evidence.
DO $$ BEGIN
  IF to_regprocedure('public.record_event_cpd_points_award_before_ownership(jsonb)') IS NULL THEN
    ALTER FUNCTION public.record_event_cpd_points_award(jsonb) RENAME TO record_event_cpd_points_award_before_ownership;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.record_event_cpd_points_award_before_ownership(jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.record_event_cpd_points_award(p_attempt jsonb)
RETURNS public.event_cpd_points_award_attempt LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  t uuid:=(p_attempt->>'tenant_id')::uuid;
  award public.member_cpd_effective_ledger%ROWTYPE;
  b jsonb; result public.event_cpd_points_award_attempt%ROWTYPE; attempt_number integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  IF t IS NULL OR NULLIF(p_attempt->>'idempotency_key','') IS NULL THEN RAISE EXCEPTION 'Invalid CPD attempt'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':cpd-ownership',0));
  SELECT * INTO award FROM public.member_cpd_effective_ledger
    WHERE tenant_id=t AND entry_kind='event_award'
      AND occurrence_key=(p_attempt->>'event_type')||':'||(p_attempt->>'event_id')||':'||
        (p_attempt->>'booking_type')||':'||(p_attempt->>'booking_id')||':'||(p_attempt->>'trigger_type');
  IF FOUND AND award.effective_member_id<>award.member_id THEN
    IF award.booking_type='booking' THEN
      SELECT to_jsonb(x) INTO b FROM public.booking x WHERE id=award.booking_id AND tenant_id=t FOR UPDATE;
    ELSE
      SELECT to_jsonb(x) INTO b FROM public.complex_event_booking x WHERE id=award.booking_id AND tenant_id=t FOR UPDATE;
    END IF;
    IF b->>'event_id'=award.event_id::text AND b->>'status'='confirmed'
      AND b->>'member_id' IN(award.member_id::text,award.effective_member_id::text) THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':cpd-points-attempt:'||(p_attempt->>'idempotency_key'),0));
      SELECT * INTO result FROM public.event_cpd_points_award_attempt
        WHERE tenant_id=t AND idempotency_key=p_attempt->>'idempotency_key'
          AND status NOT IN('pending_evidence','error') ORDER BY delivery_attempt DESC LIMIT 1;
      IF FOUND THEN RETURN result; END IF;
      SELECT COALESCE(max(delivery_attempt),0)+1 INTO attempt_number FROM public.event_cpd_points_award_attempt
        WHERE tenant_id=t AND idempotency_key=p_attempt->>'idempotency_key';
      INSERT INTO public.event_cpd_points_award_attempt(
        tenant_id,idempotency_key,event_type,event_id,booking_type,booking_id,member_id,
        trigger_type,ledger_entry_id,status,detail,delivery_attempt
      ) VALUES(t,p_attempt->>'idempotency_key',award.event_type,award.event_id,award.booking_type,award.booking_id,
        award.effective_member_id,award.award_trigger,award.id,'already_awarded',
        'Existing immutable award retained through member merge',attempt_number)
      RETURNING * INTO result;
      RETURN result;
    END IF;
  END IF;
  RETURN public.record_event_cpd_points_award_before_ownership(p_attempt);
END $$;
REVOKE ALL ON FUNCTION public.record_event_cpd_points_award(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_event_cpd_points_award(jsonb) TO service_role;

-- Keep the existing correction implementation and all its provenance checks.
-- Only the authorization lookup uses effective ownership; inserts retain the
-- original member and thus satisfy the immutable linked-evidence contract.
DO $$ BEGIN
  IF to_regprocedure('public.correct_member_cpd_points_original(uuid,uuid,uuid,text,numeric,text,text,uuid)') IS NULL THEN
    ALTER FUNCTION public.correct_member_cpd_points(uuid,uuid,uuid,text,numeric,text,text,uuid)
      RENAME TO correct_member_cpd_points_original;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.correct_member_cpd_points_original(uuid,uuid,uuid,text,numeric,text,text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.correct_member_cpd_points(
  p_tenant_id uuid,p_member_id uuid,p_ledger_entry_id uuid,p_action text,
  p_points_value numeric,p_reason text,p_actor text,p_correction_key uuid
) RETURNS public.member_cpd_points_ledger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE original_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':cpd-ownership',0));
  SELECT member_id INTO original_id FROM public.member_cpd_effective_ledger
    WHERE tenant_id=p_tenant_id AND id=p_ledger_entry_id AND effective_member_id=p_member_id;
  IF original_id IS NULL THEN RAISE EXCEPTION 'tenant member CPD award not found'; END IF;
  RETURN public.correct_member_cpd_points_original(p_tenant_id,original_id,p_ledger_entry_id,
    p_action,p_points_value,p_reason,p_actor,p_correction_key);
END $$;
REVOKE ALL ON FUNCTION public.correct_member_cpd_points(uuid,uuid,uuid,text,numeric,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.correct_member_cpd_points(uuid,uuid,uuid,text,numeric,text,text,uuid) TO service_role;

-- Pin the reviewed history implementation rather than editing live function
-- text. SQL performs aggregation and pagination after ownership resolution.
CREATE OR REPLACE FUNCTION public.get_member_cpd_points_history(
  p_tenant_id uuid,p_member_id uuid,p_page integer DEFAULT 1,p_page_size integer DEFAULT 20
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_page integer:=GREATEST(COALESCE(p_page,1),1);
  v_page_size integer:=LEAST(GREATEST(COALESCE(p_page_size,20),1),100);
  v_total bigint; v_balance numeric; v_items jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id) THEN RETURN NULL; END IF;
  SELECT count(*),COALESCE(sum(points_value),0) INTO v_total,v_balance
    FROM public.member_cpd_effective_ledger WHERE tenant_id=p_tenant_id AND effective_member_id=p_member_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.sort_date DESC,
    CASE h.entry_kind WHEN 'reversal' THEN 2 WHEN 'manual_adjustment' THEN 1 ELSE 0 END DESC,h.id DESC),'[]'::jsonb)
    INTO v_items FROM (
      SELECT ledger.id,ledger.entry_kind,ledger.points_value,ledger.ticket_name_snapshot,
        ledger.award_trigger,ledger.evidence_type,ledger.reason,ledger.reversal_of,ledger.created_at,
        ledger.activity_date,ledger.activity_title,ledger.activity_description,
        COALESCE(NULLIF(btrim(ledger.activity_title),''),
          CASE ledger.booking_type
            WHEN 'booking' THEN (SELECT NULLIF(btrim(b.event_name),'') FROM public.booking b WHERE b.id=ledger.booking_id AND b.tenant_id=ledger.tenant_id)
            WHEN 'complex_event_booking' THEN (SELECT NULLIF(btrim(b.event_name),'') FROM public.complex_event_booking b WHERE b.id=ledger.booking_id AND b.tenant_id=ledger.tenant_id)
          END,
          CASE ledger.event_type
            WHEN 'event' THEN (SELECT NULLIF(btrim(e.title),'') FROM public.event e WHERE e.id=ledger.event_id AND e.tenant_id=ledger.tenant_id)
            WHEN 'complex_event' THEN (SELECT NULLIF(btrim(e.title),'') FROM public.complex_event e WHERE e.id=ledger.event_id AND e.tenant_id=ledger.tenant_id)
          END,'Event') AS event_name,
        COALESCE(ledger.activity_date::timestamptz,
          CASE WHEN ledger.award_trigger='attendance' THEN COALESCE(
            NULLIF(ledger.evidence_snapshot->>'checkedInAt','')::timestamptz,
            NULLIF(ledger.evidence_snapshot->>'evidenceAt','')::timestamptz,
            NULLIF(ledger.evidence_snapshot->>'recordedAt','')::timestamptz)
          END,ledger.created_at) AS evidence_date,
        COALESCE(ledger.activity_date::timestamptz,ledger.created_at) AS sort_date,
        EXISTS(SELECT 1 FROM public.member_cpd_points_ledger r
          WHERE r.reversal_of=ledger.id AND r.tenant_id=ledger.tenant_id AND r.member_id=ledger.member_id) AS is_reversed
      FROM public.member_cpd_effective_ledger ledger
      WHERE ledger.tenant_id=p_tenant_id AND ledger.effective_member_id=p_member_id
      ORDER BY COALESCE(ledger.activity_date::timestamptz,ledger.created_at) DESC,
        CASE ledger.entry_kind WHEN 'reversal' THEN 2 WHEN 'manual_adjustment' THEN 1 ELSE 0 END DESC,ledger.id DESC
      OFFSET (v_page::bigint-1)*v_page_size LIMIT v_page_size
    ) h;
  RETURN jsonb_build_object('balance',v_balance::text,'items',v_items,'page',v_page,'pageSize',v_page_size,'total',v_total);
END $$;
REVOKE ALL ON FUNCTION public.get_member_cpd_points_history(uuid,uuid,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_member_cpd_points_history(uuid,uuid,integer,integer) TO service_role;
COMMIT;

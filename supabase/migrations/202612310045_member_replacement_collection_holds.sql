-- Serialize upfront replacements with the native rolling checkout lock.
-- A journal with no application is an active financial hold, including an
-- uncertain provider outcome. There is no timeout-based release.
BEGIN;
CREATE FUNCTION public.guard_member_replacement_collection_hold()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r jsonb:=to_jsonb(NEW); c jsonb; member_uuid uuid; start_date date; renewal_date date; e record;
BEGIN
 IF r->>'organization_id' IS NOT NULL OR r->>'member_id' IS NULL THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='membership_billing_agreements' AND r->>'status' IN ('cancelled','expired','failed') THEN RETURN NEW; END IF;
 member_uuid:=(r->>'member_id')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||(r->>'tenant_id')||':member_id:'||member_uuid::text,0));
 c:=CASE WHEN TG_TABLE_NAME='membership_payment_quote' THEN r#>'{quote,simResult,commitment}' ELSE r END;
 start_date:=(c->>'term_start_date')::date; renewal_date:=(c->>'membership_renewal_date')::date;
 FOR e IN SELECT execution.* FROM public.member_replacement_execution execution
  WHERE execution.tenant_id=(r->>'tenant_id')::uuid AND execution.member_id=member_uuid
   AND NOT EXISTS(SELECT 1 FROM public.member_replacement_application a WHERE a.execution_id=execution.id)
 LOOP
  IF TG_TABLE_NAME='member_membership_history' AND r->>'id'=e.source_record_id::text THEN CONTINUE; END IF;
  IF TG_TABLE_NAME='membership_payment_quote' AND EXISTS(
   SELECT 1 FROM public.member_membership_history h WHERE h.id=e.source_record_id AND h.tenant_id=e.tenant_id
    AND h.member_id=e.member_id AND h.membership_payment_quote_id=(r->>'id')::uuid
  ) THEN CONTINUE; END IF;
  IF start_date IS NULL OR renewal_date IS NULL OR
   daterange(start_date,renewal_date,'[)') && daterange((e.plan#>>'{newTerm,startDate}')::date,(e.plan#>>'{newTerm,renewalDate}')::date,'[)')
  THEN RAISE EXCEPTION 'A membership replacement is awaiting financial completion; recover it before starting another payment' USING ERRCODE='40001'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_member_replacement_collection_hold() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER aa_member_replacement_quote_hold BEFORE INSERT OR UPDATE ON public.membership_payment_quote
 FOR EACH ROW EXECUTE FUNCTION public.guard_member_replacement_collection_hold();
CREATE TRIGGER aa_member_replacement_agreement_hold BEFORE INSERT OR UPDATE ON public.membership_billing_agreements
 FOR EACH ROW EXECUTE FUNCTION public.guard_member_replacement_collection_hold();
CREATE TRIGGER aa_member_replacement_history_hold BEFORE INSERT OR UPDATE ON public.member_membership_history
 FOR EACH ROW EXECUTE FUNCTION public.guard_member_replacement_collection_hold();

ALTER FUNCTION public.begin_member_replacement(uuid,uuid,uuid,uuid,text,jsonb) RENAME TO begin_member_replacement_before_collection_hold;
REVOKE ALL ON FUNCTION public.begin_member_replacement_before_collection_hold(uuid,uuid,uuid,uuid,text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.begin_member_replacement(p_tenant_id uuid,p_member_id uuid,p_authority_id uuid,p_actor_id uuid,p_reason text,p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source public.member_membership_history; starts date; renews date; existing public.member_replacement_execution;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 SELECT * INTO existing FROM public.member_replacement_execution WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND authority_id=p_authority_id;
 IF FOUND THEN RETURN public.begin_member_replacement_before_collection_hold(p_tenant_id,p_member_id,p_authority_id,p_actor_id,p_reason,p_plan); END IF;
 starts:=(p_plan#>>'{newTerm,startDate}')::date; renews:=(p_plan#>>'{newTerm,renewalDate}')::date;
 SELECT h.* INTO source FROM public.member_membership_history h
  JOIN public.member_change_authority a ON a.source_record_id=h.id AND a.tenant_id=h.tenant_id AND a.member_id=h.member_id
  WHERE a.id=p_authority_id AND a.tenant_id=p_tenant_id AND a.member_id=p_member_id;
 IF NOT FOUND OR starts IS NULL OR renews IS NULL OR starts=source.term_start_date
 THEN RAISE EXCEPTION 'Replacement requires a distinct, verified new term'; END IF;
 IF EXISTS(SELECT 1 FROM public.member_replacement_execution e WHERE e.tenant_id=p_tenant_id AND e.member_id=p_member_id
  AND NOT EXISTS(SELECT 1 FROM public.member_replacement_application a WHERE a.execution_id=e.id))
 THEN RAISE EXCEPTION 'An existing replacement must be recovered first'; END IF;
 IF EXISTS(SELECT 1 FROM public.membership_payment_quote q WHERE q.tenant_id=p_tenant_id AND q.organization_id IS NULL AND q.member_id=p_member_id
  AND q.term_key IS NOT NULL
  AND q.id IS DISTINCT FROM source.membership_payment_quote_id
  AND NOT(source.stripe_payment_intent_id IS NOT NULL AND q.stripe_payment_intent_id IS NOT DISTINCT FROM source.stripe_payment_intent_id)
  AND daterange((q.quote#>>'{simResult,commitment,term_start_date}')::date,
   (q.quote#>>'{simResult,commitment,membership_renewal_date}')::date,'[)') && daterange(starts,renews,'[)'))
 OR EXISTS(SELECT 1 FROM public.membership_billing_agreements b WHERE b.tenant_id=p_tenant_id AND b.member_id=p_member_id AND b.organization_id IS NULL
  AND b.status NOT IN ('cancelled','expired','failed')
  AND (b.term_start_date IS NULL OR b.membership_renewal_date IS NULL
   OR daterange(b.term_start_date,b.membership_renewal_date,'[)') && daterange(starts,renews,'[)')))
 OR EXISTS(SELECT 1 FROM public.member_membership_history h WHERE h.tenant_id=p_tenant_id AND h.member_id=p_member_id
  AND h.id<>source.id AND h.status IS DISTINCT FROM 'replaced'
  AND h.term_start_date IS NOT NULL AND h.membership_renewal_date IS NOT NULL
  AND daterange(h.term_start_date,h.membership_renewal_date,'[)') && daterange(starts,renews,'[)'))
 THEN RAISE EXCEPTION 'An existing membership payment or term overlaps the replacement; resolve it before creating accounting documents'; END IF;
 RETURN public.begin_member_replacement_before_collection_hold(p_tenant_id,p_member_id,p_authority_id,p_actor_id,p_reason,p_plan);
END $$;
REVOKE ALL ON FUNCTION public.begin_member_replacement(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_member_replacement(uuid,uuid,uuid,uuid,text,jsonb) TO service_role;

ALTER FUNCTION public.apply_member_replacement(uuid,uuid,uuid,jsonb,jsonb) RENAME TO apply_member_replacement_before_collection_hold;
REVOKE ALL ON FUNCTION public.apply_member_replacement_before_collection_hold(uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.apply_member_replacement(p_tenant_id uuid,p_execution_id uuid,p_actor_id uuid,p_evidence jsonb,p_history jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE member_uuid uuid;
BEGIN
 SELECT member_id INTO member_uuid FROM public.member_replacement_execution WHERE id=p_execution_id AND tenant_id=p_tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Replacement not found'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||member_uuid::text,0));
 RETURN public.apply_member_replacement_before_collection_hold(p_tenant_id,p_execution_id,p_actor_id,p_evidence,p_history);
END $$;
REVOKE ALL ON FUNCTION public.apply_member_replacement(uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.apply_member_replacement(uuid,uuid,uuid,jsonb,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

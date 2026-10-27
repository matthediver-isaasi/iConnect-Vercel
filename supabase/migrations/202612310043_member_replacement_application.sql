-- Application remains internal; a settlement observation is not a new charge.
BEGIN;
CREATE TABLE public.member_replacement_application (
 execution_id uuid PRIMARY KEY REFERENCES public.member_replacement_execution(id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 source_record_id uuid NOT NULL REFERENCES public.member_membership_history(id),
 target_record_id uuid NOT NULL UNIQUE REFERENCES public.member_membership_history(id) DEFERRABLE,
 applied_by uuid NOT NULL,
 evidence jsonb NOT NULL,
 snapshot jsonb NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_replacement_application ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_replacement_application FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_replacement_application TO service_role;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.member_replacement_application
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();
-- Only a protected replacement may retire a signed interval from the overlap
-- guard. Ordinary expired records retain exactly the previous protection.
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.member_membership_history WHERE status='replaced') THEN
  RAISE EXCEPTION 'Existing replaced records need provenance review before rollout';
 END IF;
END $$;
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE public.member_membership_history DROP CONSTRAINT IF EXISTS member_membership_history_rolling_no_overlap;
ALTER TABLE public.member_membership_history ADD CONSTRAINT member_membership_history_rolling_no_overlap
 EXCLUDE USING gist(tenant_id WITH =,member_id WITH =,daterange(term_start_date,membership_renewal_date,'[)') WITH &&)
 WHERE(term_key IS NOT NULL AND status IS DISTINCT FROM 'replaced');
CREATE FUNCTION public.guard_member_replacement_retirement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.status='replaced' AND NEW.status IS DISTINCT FROM OLD.status THEN
  RAISE EXCEPTION 'A replaced purchase cannot be reactivated';
 END IF;
 IF NEW.status='replaced' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
  IF TG_OP='INSERT' OR NOT EXISTS(SELECT 1 FROM public.member_replacement_application a
   WHERE a.tenant_id=NEW.tenant_id AND a.member_id=NEW.member_id AND a.source_record_id=NEW.id) THEN
   RAISE EXCEPTION 'Protected replacement application required to retire this purchase';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_member_replacement_retirement() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER member_replacement_retirement BEFORE INSERT OR UPDATE OF status ON public.member_membership_history
 FOR EACH ROW EXECUTE FUNCTION public.guard_member_replacement_retirement();
-- A consumed checkout is retained as original payment evidence. It ceases to
-- reserve an interval only through this protected, paid replacement lineage.
DO $$
DECLARE body text; needle text:=$n$AND q.id IS DISTINCT FROM (payment_quote->>'id')::uuid$n$;
BEGIN
 body:=pg_get_functiondef('public.enforce_rolling_membership_commitment()'::regprocedure);
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'Rolling checkout reservation contract needs review'; END IF;
 body:=replace(body,needle,needle||$extra$
         AND NOT EXISTS(
           SELECT 1 FROM public.member_replacement_application replaced
           JOIN public.member_membership_history original ON original.id=replaced.source_record_id
             AND original.tenant_id=replaced.tenant_id AND original.member_id=replaced.member_id
           WHERE replaced.tenant_id=q.tenant_id AND replaced.member_id=q.member_id
             AND q.organization_id IS NULL AND original.status='replaced'
             AND (to_jsonb(original)->>'membership_payment_quote_id'=q.id::text
               OR (q.stripe_payment_intent_id IS NOT NULL
                AND to_jsonb(original)->>'stripe_payment_intent_id'=q.stripe_payment_intent_id)))
 $extra$);
 EXECUTE body;
END $$;
CREATE FUNCTION public.apply_member_replacement(
 p_tenant_id uuid,p_execution_id uuid,p_actor_id uuid,p_evidence jsonb,p_history jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.member_replacement_execution; a public.member_change_authority;
 prior public.member_replacement_application; source jsonb; target jsonb; m jsonb; history jsonb;
 columns_sql text; values_sql text; c jsonb; invoice_id text;
BEGIN
 SELECT * INTO e FROM public.member_replacement_execution WHERE tenant_id=p_tenant_id AND id=p_execution_id;
 IF NOT FOUND OR p_actor_id IS NULL THEN RAISE EXCEPTION 'Execution and audit actor required'; END IF;
 SELECT to_jsonb(t) INTO m FROM public.member t WHERE tenant_id=p_tenant_id AND id=e.member_id FOR UPDATE;
 IF m IS NULL THEN RAISE EXCEPTION 'Member not found'; END IF;
 SELECT * INTO prior FROM public.member_replacement_application WHERE execution_id=e.id;
 IF FOUND THEN RETURN to_jsonb(prior); END IF;
 SELECT * INTO a FROM public.member_change_authority WHERE id=e.authority_id AND tenant_id=p_tenant_id;
 SELECT to_jsonb(h) INTO source FROM public.member_membership_history h
  WHERE id=e.source_record_id AND tenant_id=p_tenant_id AND member_id=e.member_id FOR UPDATE;
 SELECT to_jsonb(t) INTO target FROM public.membership_tier_config t
  WHERE id=(a.authority->'targetSnapshot'->>'id')::uuid AND tenant_id=p_tenant_id FOR SHARE;
 c:=a.authority->'calculation';
 IF source IS NULL OR source IS DISTINCT FROM a.authority->'sourceSnapshot'
  OR source->>'status' IS DISTINCT FROM 'active'
  OR source->>'payment_status' IS DISTINCT FROM 'paid'
  OR (source->>'membership_renewal_date')::date<=CURRENT_DATE
  OR COALESCE((m->>'membership_paused')::boolean,false)
  OR target IS DISTINCT FROM a.authority->'targetSnapshot'
  OR NOT public.member_amendment_operational_scope_supported(source,target)
  OR EXISTS(SELECT 1 FROM public.member_membership_history h WHERE h.tenant_id=p_tenant_id
   AND h.member_id=e.member_id AND h.id<>e.source_record_id AND h.status='active'
   AND (h.membership_renewal_date>CURRENT_DATE OR h.term_end_date>=CURRENT_DATE))
 THEN RAISE EXCEPTION 'Membership changed before application; financial review required'; END IF;
 -- Credit issuance needs the common backed-credit source extension before it
 -- may be applied. Never activate while leaving a promised voucher unissued.
 IF e.plan->>'choice'='credit' THEN RAISE EXCEPTION 'Replacement credit issuance is not enabled'; END IF;
 IF EXISTS(SELECT 1 FROM public.member_replacement_step WHERE execution_id=e.id AND state<>'observed')
  OR p_evidence->>'verified' IS DISTINCT FROM 'true'
  OR p_evidence->>'kind' IS DISTINCT FROM 'replacement_settled'
  OR p_evidence->>'provider' IS DISTINCT FROM 'xero'
  OR p_evidence->>'currency' IS DISTINCT FROM e.plan->>'currency'
  OR p_evidence->'amount' IS DISTINCT FROM e.plan->'targetFullPrice'
  OR p_evidence->'transferred' IS DISTINCT FROM e.plan->'transferred'
  OR p_evidence->>'providerTenantId' IS DISTINCT FROM e.plan->'steps'->0->>'providerTenantId'
 THEN RAISE EXCEPTION 'Complete verified replacement settlement required'; END IF;
 SELECT evidence->>'id' INTO invoice_id FROM public.member_replacement_step
  WHERE execution_id=e.id AND step_key='new_invoice' AND state='observed';
 IF invoice_id IS NULL OR invoice_id IS DISTINCT FROM p_evidence->>'invoiceId'
  OR jsonb_typeof(p_evidence->'cashPayments') IS DISTINCT FROM 'array'
  OR (SELECT COALESCE(sum((value->>'amountMinor')::bigint),0)
   FROM jsonb_array_elements(p_evidence->'cashPayments')) IS DISTINCT FROM (e.plan->>'additionalPaymentMinor')::bigint
 THEN RAISE EXCEPTION 'Replacement invoice and cash coverage differ'; END IF;
 IF (e.plan->'transferred'->>'grossMinor')::bigint>0 AND (
  p_evidence->>'transferCreditNoteId' IS DISTINCT FROM
   (SELECT evidence->>'id' FROM public.member_replacement_step WHERE execution_id=e.id AND step_key='transfer_note')
  OR p_evidence->>'transferAllocationId' IS DISTINCT FROM
   (SELECT evidence->>'id' FROM public.member_replacement_step WHERE execution_id=e.id AND step_key='transfer_allocation'))
 THEN RAISE EXCEPTION 'Replacement transfer identities differ'; END IF;
 IF e.plan->>'choice'='refund' AND (p_evidence->'surplusEvidence'->>'kind' IS DISTINCT FROM 'refunded'
  OR p_evidence->'surplusEvidence'->>'verified' IS DISTINCT FROM 'true') THEN
  RAISE EXCEPTION 'Verified refund required'; END IF;
 IF p_history->>'tenant_id' IS DISTINCT FROM p_tenant_id::text OR p_history->>'member_id' IS DISTINCT FROM e.member_id::text
  OR p_history->>'config_id' IS DISTINCT FROM target->>'id'
  OR p_history->>'band_id' IS DISTINCT FROM a.authority->'targetBandSnapshot'->>'id'
  OR p_history->>'previous_term_id' IS NOT NULL
  OR p_history->>'term_start_date' IS DISTINCT FROM c->'newTerm'->>'startDate'
  OR p_history->>'membership_renewal_date' IS DISTINCT FROM c->'newTerm'->>'renewalDate'
  OR (p_history->>'term_end_date')::date IS DISTINCT FROM (c->'newTerm'->>'renewalDate')::date-1
  OR p_history->>'status' IS DISTINCT FROM 'active' OR p_history->>'payment_status' IS DISTINCT FROM 'paid'
  OR p_history->>'currency' IS DISTINCT FROM e.plan->>'currency'
  OR p_history->>'accounting_provider' IS DISTINCT FROM 'xero'
  OR p_history->>'accounting_invoice_id' IS DISTINCT FROM invoice_id
  OR (p_history->>'final_cost')::numeric*100 IS DISTINCT FROM (e.plan->'targetFullPrice'->>'netMinor')::numeric
  OR (p_history->>'annual_cost')::numeric*100 IS DISTINCT FROM (e.plan->'targetFullPrice'->>'netMinor')::numeric
  OR (p_history->>'vat_amount')::numeric*100 IS DISTINCT FROM (e.plan->'targetFullPrice'->>'vatMinor')::numeric
  OR (p_history->>'total_with_vat')::numeric*100 IS DISTINCT FROM (e.plan->'targetFullPrice'->>'grossMinor')::numeric
  OR p_history->'commitment_snapshot'->'config' IS DISTINCT FROM target
  OR p_history->'commitment_snapshot'->>'payment_frequency' IS DISTINCT FROM 'upfront'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_history) k WHERE NOT EXISTS(
   SELECT 1 FROM pg_attribute WHERE attrelid='public.member_membership_history'::regclass
    AND attname=k AND attnum>0 AND NOT attisdropped))
 THEN RAISE EXCEPTION 'New purchase differs from the confirmed replacement'; END IF;
 -- Reserve immutable application lineage before retiring the old interval.
 -- The deferred target FK must resolve in this same transaction.
 SET CONSTRAINTS member_replacement_application_target_record_id_fkey DEFERRED;
 INSERT INTO public.member_replacement_application(execution_id,tenant_id,member_id,source_record_id,
  target_record_id,applied_by,evidence,snapshot)
 VALUES(e.id,p_tenant_id,e.member_id,e.source_record_id,(p_history->>'id')::uuid,p_actor_id,p_evidence,p_history)
 RETURNING * INTO prior;
 UPDATE public.member_membership_history SET status='replaced' WHERE id=e.source_record_id AND tenant_id=p_tenant_id;
 SELECT string_agg(format('%I',k),',' ORDER BY k),string_agg(format('r.%I',k),',' ORDER BY k)
 INTO columns_sql,values_sql FROM jsonb_object_keys(p_history) k;
 EXECUTE format('INSERT INTO public.member_membership_history(%s)
  SELECT %s FROM jsonb_populate_record(NULL::public.member_membership_history,$1) r
  RETURNING to_jsonb(member_membership_history)',columns_sql,values_sql) INTO history USING p_history;
 SET CONSTRAINTS member_replacement_application_target_record_id_fkey IMMEDIATE;
 INSERT INTO public.member_replacement_event(execution_id,actor_id,kind,evidence)
 VALUES(e.id,p_actor_id,'membership_applied',jsonb_build_object('sourceRecordId',e.source_record_id,'targetRecordId',prior.target_record_id));
 RETURN to_jsonb(prior);
END $$;
REVOKE ALL ON FUNCTION public.apply_member_replacement(uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.apply_member_replacement(uuid,uuid,uuid,jsonb,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

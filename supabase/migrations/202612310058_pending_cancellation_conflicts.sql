BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.member_cancellation_request
  WHERE access_ended_at IS NULL AND withdrawn_at IS NULL) THEN
  RAISE EXCEPTION 'Review existing pending cancellations before installing the purchase conflict guard';
 END IF;
END $$;

CREATE FUNCTION public.guard_cancellation_admission_conflicts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.member WHERE id=NEW.member_id AND tenant_id=NEW.tenant_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.member_change_authority
   WHERE tenant_id=NEW.tenant_id AND source_record_id=NEW.source_record_id)
  OR EXISTS(SELECT 1 FROM public.member_membership_amendment
   WHERE tenant_id=NEW.tenant_id AND source_record_id=NEW.source_record_id) THEN
  RAISE EXCEPTION 'An amended purchase requires revised financial authority before cancellation';
 END IF;
 IF EXISTS(SELECT 1 FROM public.member_membership_history h
  WHERE h.tenant_id=NEW.tenant_id AND h.member_id=NEW.member_id AND h.id<>NEW.source_record_id
   AND COALESCE(h.status,'') NOT IN ('replaced','cancelled_by_request','expired_checkout','expired','failed')
   AND (h.membership_renewal_date IS NULL OR h.membership_renewal_date>current_date))
  OR EXISTS(SELECT 1 FROM public.membership_billing_agreements a
   WHERE a.tenant_id=NEW.tenant_id AND a.member_id=NEW.member_id AND a.agreement_type='member'
    AND a.id IS DISTINCT FROM (NEW.source_snapshot->>'billing_agreement_id')::uuid
    AND a.status IN ('payment_setup_required','mandate_pending','first_payment_pending','active',
     'payment_grace_period','payment_overdue')) THEN
  RAISE EXCEPTION 'Another membership purchase or payment arrangement requires review before cancellation';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.guard_pending_cancellation_purchase()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n jsonb:=to_jsonb(NEW); o jsonb; key text; changed boolean:=false;
BEGIN
 IF NEW.member_id IS NULL OR n->>'organization_id' IS NOT NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  o:=to_jsonb(OLD);
  FOREACH key IN ARRAY ARRAY['tenant_id','member_id','term_key','term_start_date','membership_renewal_date'] LOOP
   changed:=changed OR (n->key IS DISTINCT FROM o->key);
  END LOOP;
  changed:=changed OR (n#>'{metadata,card,commitment}' IS DISTINCT FROM o#>'{metadata,card,commitment}')
   OR (n#>'{metadata,dd,commitment}' IS DISTINCT FROM o#>'{metadata,dd,commitment}')
   OR (n#>'{quote,simResult,commitment}' IS DISTINCT FROM o#>'{quote,simResult,commitment}');
  IF NOT changed THEN RETURN NEW; END IF;
 END IF;
 PERFORM 1 FROM public.member WHERE id=NEW.member_id AND tenant_id=NEW.tenant_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.member_cancellation_request r
  WHERE r.tenant_id=NEW.tenant_id AND r.member_id=NEW.member_id
   AND r.access_ended_at IS NULL AND r.withdrawn_at IS NULL) THEN
  RAISE EXCEPTION 'A pending cancellation must be resolved before another membership purchase or renewal';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.guard_cancelled_source_amendment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.member WHERE id=NEW.member_id AND tenant_id=NEW.tenant_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.member_cancellation_request r
  WHERE r.tenant_id=NEW.tenant_id AND r.member_id=NEW.member_id
   AND r.source_record_id=NEW.source_record_id AND r.withdrawn_at IS NULL) THEN
  RAISE EXCEPTION 'This purchase has a cancellation request; a competing amendment is not allowed';
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER zz_cancellation_admission_conflicts BEFORE INSERT ON public.member_cancellation_request
 FOR EACH ROW EXECUTE FUNCTION public.guard_cancellation_admission_conflicts();
CREATE TRIGGER zz_pending_cancellation_purchase BEFORE INSERT OR UPDATE ON public.member_membership_history
 FOR EACH ROW EXECUTE FUNCTION public.guard_pending_cancellation_purchase();
CREATE TRIGGER zz_pending_cancellation_purchase BEFORE INSERT OR UPDATE ON public.membership_payment_quote
 FOR EACH ROW EXECUTE FUNCTION public.guard_pending_cancellation_purchase();
CREATE TRIGGER zz_pending_cancellation_purchase BEFORE INSERT OR UPDATE ON public.membership_billing_agreements
 FOR EACH ROW EXECUTE FUNCTION public.guard_pending_cancellation_purchase();
CREATE TRIGGER zz_cancelled_source_amendment BEFORE INSERT ON public.member_change_authority
 FOR EACH ROW EXECUTE FUNCTION public.guard_cancelled_source_amendment();
CREATE TRIGGER zz_cancelled_source_amendment BEFORE INSERT ON public.member_membership_amendment
 FOR EACH ROW EXECUTE FUNCTION public.guard_cancelled_source_amendment();
REVOKE ALL ON FUNCTION public.guard_cancellation_admission_conflicts(),
 public.guard_pending_cancellation_purchase(),public.guard_cancelled_source_amendment()
 FROM PUBLIC,anon,authenticated,service_role;
COMMIT;

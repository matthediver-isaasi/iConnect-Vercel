BEGIN;
CREATE TABLE public.event_funnel_training_reservation (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  member_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  state text NOT NULL DEFAULT 'held' CHECK(state IN ('held','committed','released')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,order_id),
  FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
CREATE INDEX event_funnel_training_reserved ON public.event_funnel_training_reservation(tenant_id,organization_id)
  WHERE state='held';
ALTER TABLE public.event_funnel_training_reservation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_training_reservation FROM PUBLIC,anon,authenticated,service_role;

-- Serialize with every legacy balance writer on the organization row. Holds
-- do not debit the balance or create a consumption transaction.
CREATE FUNCTION public.event_funnel_training_balance_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE reserved bigint;
BEGIN
  SELECT coalesce(sum(amount_minor),0) INTO reserved FROM public.event_funnel_training_reservation
    WHERE tenant_id=OLD.tenant_id AND organization_id=OLD.id AND state='held';
  IF reserved>0 AND (TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR floor(coalesce(NEW.training_fund_balance,0)*100)<reserved) THEN
    RAISE EXCEPTION 'Training funds are reserved by an unfinished checkout' USING ERRCODE='PT409';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_training_balance_guard BEFORE DELETE OR UPDATE OF id,tenant_id,training_fund_balance ON public.organization
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_training_balance_guard();

CREATE FUNCTION public.event_funnel_training_reserve()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE requested bigint; member_row public.member; organization_row public.organization; held bigint; purchaser uuid;
BEGIN
  requested:=coalesce((NEW.snapshot->>'trainingFundMinor')::bigint,0);
  IF requested<0 THEN RAISE EXCEPTION 'Invalid training funding' USING ERRCODE='22023'; END IF;
  IF requested=0 THEN RETURN NEW; END IF;
  SELECT member_id INTO purchaser FROM public.event_funnel_session WHERE tenant_id=NEW.tenant_id AND id=NEW.session_id;
  SELECT * INTO member_row FROM public.member WHERE tenant_id=NEW.tenant_id AND id=purchaser FOR SHARE;
  IF NOT FOUND OR member_row.organization_id IS NULL THEN
    RAISE EXCEPTION 'Training fund requires an organization member' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM public.system_settings WHERE tenant_id=NEW.tenant_id
    AND setting_key='event_allow_training_fund_payment' AND lower(trim(setting_value))='false') THEN
    RAISE EXCEPTION 'Training fund payment is disabled' USING ERRCODE='42501';
  END IF;
  SELECT * INTO organization_row FROM public.organization
    WHERE tenant_id=NEW.tenant_id AND id=member_row.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Training fund organization unavailable' USING ERRCODE='42501'; END IF;
  IF jsonb_array_length(coalesce(to_jsonb(organization_row.training_fund_allowed_role_ids),'[]'::jsonb))>0
    AND NOT coalesce(to_jsonb(organization_row.training_fund_allowed_role_ids) ? member_row.role_id::text,false) THEN
    RAISE EXCEPTION 'Training fund role not permitted' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(sum(amount_minor),0) INTO held FROM public.event_funnel_training_reservation
    WHERE tenant_id=NEW.tenant_id AND organization_id=organization_row.id AND state='held';
  IF floor(coalesce(organization_row.training_fund_balance,0)*100)-held<requested THEN
    RAISE EXCEPTION 'Training fund balance changed' USING ERRCODE='PT409';
  END IF;
  INSERT INTO public.event_funnel_training_reservation(tenant_id,order_id,organization_id,member_id,amount_minor)
    VALUES(NEW.tenant_id,NEW.id,organization_row.id,member_row.id,requested);
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_training_reserve AFTER INSERT ON public.event_funnel_order
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_training_reserve();

CREATE FUNCTION public.event_funnel_training_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE reservation public.event_funnel_training_reservation; before_balance numeric; amount numeric;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state OR NEW.state NOT IN ('confirmed','cancelled','failed') THEN RETURN NEW; END IF;
  SELECT * INTO reservation FROM public.event_funnel_training_reservation
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id;
  IF NOT FOUND OR reservation.state<>'held' THEN RETURN NEW; END IF;
  SELECT training_fund_balance INTO before_balance FROM public.organization
    WHERE tenant_id=NEW.tenant_id AND id=reservation.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reserved training fund organization unavailable' USING ERRCODE='PT409'; END IF;
  IF NEW.state IN ('cancelled','failed') THEN
    IF NEW.verified_payment IS NOT NULL THEN RAISE EXCEPTION 'Paid training reservation cannot be released' USING ERRCODE='PT409'; END IF;
    UPDATE public.event_funnel_training_reservation SET state='released' WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id;
    RETURN NEW;
  END IF;
  amount:=reservation.amount_minor/100.0;
  IF coalesce(before_balance,0)<amount THEN RAISE EXCEPTION 'Reserved training balance unavailable' USING ERRCODE='PT409'; END IF;
  UPDATE public.event_funnel_training_reservation SET state='committed' WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id;
  UPDATE public.organization SET training_fund_balance=coalesce(training_fund_balance,0)-amount
    WHERE tenant_id=NEW.tenant_id AND id=reservation.organization_id;
  INSERT INTO public.training_fund_transaction(tenant_id,organization_id,type,amount,balance_before,balance_after,reason)
    VALUES(NEW.tenant_id,reservation.organization_id,'booking_usage',amount,before_balance,before_balance-amount,'Event checkout '||NEW.id::text);
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_training_transition AFTER UPDATE OF state ON public.event_funnel_order
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_training_transition();
REVOKE ALL ON FUNCTION public.event_funnel_training_reserve(),public.event_funnel_training_transition(),
  public.event_funnel_training_balance_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.event_funnel_training_quote(p_tenant uuid,p_id uuid,p_member uuid,p_capability_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.event_funnel_session; m public.member; o public.organization; reserved bigint;
BEGIN
  s:=public.event_funnel_owned_session(p_tenant,p_id,p_member,p_capability_hash);
  SELECT * INTO m FROM public.member WHERE tenant_id=p_tenant AND id=s.member_id;
  IF NOT FOUND OR m.organization_id IS NULL THEN RETURN '{"enabled":false}'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM public.system_settings WHERE tenant_id=p_tenant AND setting_key='event_allow_training_fund_payment'
    AND lower(trim(setting_value))='false') THEN RETURN '{"enabled":false}'::jsonb; END IF;
  SELECT * INTO o FROM public.organization WHERE tenant_id=p_tenant AND id=m.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Training fund organization unavailable' USING ERRCODE='PT409'; END IF;
  IF jsonb_array_length(coalesce(to_jsonb(o.training_fund_allowed_role_ids),'[]'::jsonb))>0
    AND NOT coalesce(to_jsonb(o.training_fund_allowed_role_ids) ? m.role_id::text,false) THEN
    RETURN '{"enabled":false}'::jsonb;
  END IF;
  SELECT coalesce(sum(amount_minor),0) INTO reserved FROM public.event_funnel_training_reservation
    WHERE tenant_id=p_tenant AND organization_id=o.id AND state='held';
  RETURN jsonb_build_object('enabled',true,'organizationId',o.id,'availableMinor',greatest(0,floor(coalesce(o.training_fund_balance,0)*100)-reserved));
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_training_quote(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_training_quote(uuid,uuid,uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.event_funnel_training_ready() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
COMMIT;

BEGIN;
ALTER TABLE public.membership_tier_config
  ADD COLUMN IF NOT EXISTS term_end_mode text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS term_end_field_id uuid;
ALTER TABLE public.member_membership_history
  ADD COLUMN IF NOT EXISTS term_source_snapshot jsonb;
ALTER TABLE public.membership_tier_config
  ADD CONSTRAINT membership_term_end_field_fk FOREIGN KEY(term_end_field_id) REFERENCES public.preference_field(id);

CREATE OR REPLACE FUNCTION public.guard_member_date_field() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.membership_tier_config WHERE term_end_field_id=OLD.id)
    AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.entity_scope IS DISTINCT FROM 'member'
      OR NEW.field_type IS DISTINCT FROM 'date' OR NEW.is_active IS NOT TRUE OR NEW.custom_object_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This date field is used by a membership schedule';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_date_field_guard BEFORE UPDATE ON public.preference_field
  FOR EACH ROW EXECUTE FUNCTION public.guard_member_date_field();

CREATE OR REPLACE FUNCTION public.guard_member_date_schedule() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.term_end_mode='member_date_field' OR (TG_OP='UPDATE' AND OLD.term_end_mode='member_date_field'))
    AND current_user <> 'service_role' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
    RAISE EXCEPTION 'Member date schedules require the protected server path';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.term_end_mode IS DISTINCT FROM OLD.term_end_mode
      OR NEW.term_end_field_id IS DISTINCT FROM OLD.term_end_field_id)
    AND EXISTS(SELECT 1 FROM public.member_membership_history WHERE config_id=OLD.id) THEN
    RAISE EXCEPTION 'Create a new schedule to change the term policy after memberships have been issued';
  END IF;
  IF NEW.term_end_mode NOT IN ('standard','member_date_field') THEN
    RAISE EXCEPTION 'Invalid membership term end mode';
  END IF;
  IF NEW.term_end_mode = 'standard' THEN
    IF NEW.term_end_field_id IS NOT NULL THEN RAISE EXCEPTION 'Standard term cannot select a date field'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.structure_scope_type IS DISTINCT FROM 'member' OR NEW.pricing_model IS DISTINCT FROM 'flat'
    OR NEW.flat_cost IS DISTINCT FROM 0 OR coalesce(NEW.dd_enabled,false)
    OR coalesce(NEW.card_monthly_enabled,false) OR coalesce(NEW.prorata_enabled,false)
    OR coalesce(NEW.free_period_amount,0) <> 0 OR coalesce(NEW.rollover_enabled,false) THEN
    RAISE EXCEPTION 'Member-date terms require an individual flat no-charge schedule without instalments or discounts';
  END IF;
  PERFORM 1 FROM public.preference_field p WHERE p.id=NEW.term_end_field_id
    AND p.tenant_id=NEW.tenant_id AND p.entity_scope='member' AND p.field_type='date'
    AND p.is_active IS TRUE AND p.custom_object_id IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select an active member date field belonging to this tenant'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_date_schedule_guard ON public.membership_tier_config;
CREATE TRIGGER member_date_schedule_guard BEFORE INSERT OR UPDATE ON public.membership_tier_config
  FOR EACH ROW EXECUTE FUNCTION public.guard_member_date_schedule();

CREATE TABLE IF NOT EXISTS public.member_date_term_extension (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL, member_id uuid NOT NULL, history_id uuid NOT NULL,
  previous_end_date date NOT NULL, new_end_date date NOT NULL,
  previous_field_value text,
  actor text NOT NULL CHECK(length(trim(actor))>0),
  reason text NOT NULL CHECK(length(trim(reason))>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (new_end_date > previous_end_date)
);
ALTER TABLE public.member_date_term_extension ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_date_term_extension FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.member_date_term_extension TO service_role;

CREATE OR REPLACE FUNCTION public.guard_member_date_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE cfg public.membership_tier_config; owner_id uuid; date_value text;
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM public.member WHERE id=NEW.member_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  END IF;
  IF TG_OP='UPDATE' AND OLD.term_source_snapshot IS NOT NULL THEN
    IF NEW.term_source_snapshot IS DISTINCT FROM OLD.term_source_snapshot
      OR NEW.member_id IS DISTINCT FROM OLD.member_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.config_id IS DISTINCT FROM OLD.config_id OR NEW.term_start_date IS DISTINCT FROM OLD.term_start_date THEN
      RAISE EXCEPTION 'Member date-term evidence is immutable';
    END IF;
    IF (NEW.term_end_date IS DISTINCT FROM OLD.term_end_date OR
        NEW.membership_renewal_date IS DISTINCT FROM OLD.membership_renewal_date)
       AND current_setting('app.member_date_extension',true) IS DISTINCT FROM OLD.id::text THEN
      RAISE EXCEPTION 'Use the audited manual extension action';
    END IF;
  END IF;
  SELECT * INTO cfg FROM public.membership_tier_config WHERE id=NEW.config_id AND tenant_id=NEW.tenant_id;
  IF (cfg.term_end_mode='member_date_field' OR NEW.term_source_snapshot IS NOT NULL
      OR (TG_OP='UPDATE' AND OLD.term_source_snapshot IS NOT NULL))
    AND current_user <> 'service_role' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
    RAISE EXCEPTION 'Member date terms require the protected server path';
  END IF;
  -- The administrator's existing creation RPC writes explicit term dates but
  -- does not carry the new snapshot column. Derive it only from saved evidence.
  IF TG_OP='INSERT' AND NEW.term_source_snapshot IS NULL AND cfg.term_end_mode='member_date_field' THEN
    SELECT value INTO STRICT date_value FROM public.member_preference_value
      WHERE member_id=NEW.member_id AND field_id=cfg.term_end_field_id;
    IF date_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR date_value::date IS DISTINCT FROM NEW.term_end_date THEN
      RAISE EXCEPTION 'Saved member date changed; request a fresh preview';
    END IF;
    NEW.term_source_snapshot := jsonb_build_object('version',1,'type','member_date_field',
      'tenant_id',NEW.tenant_id,'member_id',NEW.member_id,'field_id',cfg.term_end_field_id,
      'end_date',NEW.term_end_date,'grace_days',coalesce(to_jsonb(cfg)->>'renewal_grace_days','0')::integer);
  END IF;
  IF NEW.term_source_snapshot IS NULL THEN
    IF cfg.term_end_mode='member_date_field' THEN RAISE EXCEPTION 'A verified member date-term snapshot is required'; END IF;
    IF NEW.term_start_date IS NOT NULL AND NEW.term_end_date IS NOT NULL
      AND coalesce(NEW.status,'') NOT IN ('expired_checkout','voided','cancelled')
      AND coalesce(NEW.payment_status,'') NOT IN ('voided','cancelled')
      AND EXISTS(SELECT 1 FROM public.member_membership_history h WHERE h.tenant_id=NEW.tenant_id
        AND h.member_id=NEW.member_id AND h.id<>NEW.id AND h.term_source_snapshot IS NOT NULL
        AND coalesce(h.status,'') NOT IN ('expired_checkout','voided','cancelled')
        AND coalesce(h.payment_status,'') NOT IN ('voided','cancelled')
        AND daterange(h.term_start_date,h.term_end_date,'[]') && daterange(NEW.term_start_date,NEW.term_end_date,'[]')) THEN
      RAISE EXCEPTION 'Membership overlaps an existing member-date term';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.term_source_snapshot->>'type' IS DISTINCT FROM 'member_date_field'
    OR cfg.term_end_mode IS DISTINCT FROM 'member_date_field'
    OR NEW.annual_cost IS DISTINCT FROM 0 OR NEW.final_cost IS DISTINCT FROM 0
    OR NEW.total_with_vat IS DISTINCT FROM 0 OR coalesce(NEW.vat_amount,0) <> 0
    OR NEW.billing_agreement_id IS NOT NULL OR NEW.term_key IS NOT NULL
    OR NEW.term_start_date IS NULL OR NEW.term_end_date IS NULL OR NEW.term_end_date < NEW.term_start_date
    OR NEW.membership_renewal_date IS DISTINCT FROM NEW.term_end_date+1
    OR NEW.term_source_snapshot->>'tenant_id' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.term_source_snapshot->>'member_id' IS DISTINCT FROM NEW.member_id::text THEN
    RAISE EXCEPTION 'Invalid no-charge member date-term record';
  END IF;
  IF TG_OP='INSERT' OR OLD.term_source_snapshot IS NULL THEN
    IF NEW.term_source_snapshot->>'field_id' IS DISTINCT FROM cfg.term_end_field_id::text
      OR (NEW.term_source_snapshot->>'end_date')::date IS DISTINCT FROM NEW.term_end_date THEN
      RAISE EXCEPTION 'Term date evidence does not match schedule';
    END IF;
    SELECT id INTO owner_id FROM public.member WHERE id=NEW.member_id AND tenant_id=NEW.tenant_id FOR UPDATE;
    IF owner_id IS NULL THEN RAISE EXCEPTION 'Member does not belong to tenant'; END IF;
    IF EXISTS (SELECT 1 FROM public.member_membership_history h WHERE h.member_id=NEW.member_id
      AND h.tenant_id=NEW.tenant_id AND h.id<>NEW.id
      AND coalesce(h.status,'') NOT IN ('expired_checkout','voided','cancelled')
      AND coalesce(h.payment_status,'') NOT IN ('voided','cancelled')
      AND (h.term_start_date IS NULL OR h.term_end_date IS NULL OR
        daterange(h.term_start_date,h.term_end_date,'[]') && daterange(NEW.term_start_date,NEW.term_end_date,'[]'))) THEN
      RAISE EXCEPTION 'Existing membership overlaps or needs historical review';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_date_history_guard ON public.member_membership_history;
CREATE TRIGGER member_date_history_guard BEFORE INSERT OR UPDATE ON public.member_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_member_date_history();

CREATE OR REPLACE FUNCTION public.extend_member_date_term(
  p_tenant_id uuid,p_member_id uuid,p_history_id uuid,p_expected_end date,p_new_end date,p_actor text,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE h public.member_membership_history; audit_id uuid; previous_field text; source_field uuid;
BEGIN
  PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found'; END IF;
  SELECT * INTO h FROM public.member_membership_history
    WHERE id=p_history_id AND member_id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF h.id IS NULL OR h.term_source_snapshot->>'type' IS DISTINCT FROM 'member_date_field'
    OR h.term_end_date IS DISTINCT FROM p_expected_end OR p_new_end IS NULL OR p_new_end<=h.term_end_date
    OR nullif(trim(p_actor),'') IS NULL OR nullif(trim(p_reason),'') IS NULL THEN
    RAISE EXCEPTION 'Invalid or stale manual extension';
  END IF;
  IF EXISTS(SELECT 1 FROM public.member_membership_history x WHERE x.tenant_id=p_tenant_id
    AND x.member_id=p_member_id AND x.id<>h.id AND coalesce(x.status,'') NOT IN ('expired_checkout','voided','cancelled')
    AND coalesce(x.payment_status,'') NOT IN ('voided','cancelled')
    AND (x.term_start_date IS NULL OR x.term_end_date IS NULL OR
      daterange(x.term_start_date,x.term_end_date,'[]') && daterange(h.term_start_date,p_new_end,'[]'))) THEN
    RAISE EXCEPTION 'Extension overlaps another membership or unresolved history';
  END IF;
  source_field := (h.term_source_snapshot->>'field_id')::uuid;
  PERFORM 1 FROM public.preference_field WHERE id=source_field AND tenant_id=p_tenant_id
    AND entity_scope='member' AND field_type='date' AND is_active IS TRUE FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The original membership date field is unavailable'; END IF;
  SELECT value INTO previous_field FROM public.member_preference_value
    WHERE member_id=p_member_id AND field_id=source_field FOR UPDATE;
  INSERT INTO public.member_date_term_extension(tenant_id,member_id,history_id,previous_end_date,new_end_date,previous_field_value,actor,reason)
    VALUES(p_tenant_id,p_member_id,h.id,h.term_end_date,p_new_end,previous_field,p_actor,trim(p_reason)) RETURNING id INTO audit_id;
  INSERT INTO public.member_preference_value(member_id,field_id,value)
    VALUES(p_member_id,source_field,p_new_end::text)
    ON CONFLICT(member_id,field_id) DO UPDATE SET value=excluded.value;
  PERFORM set_config('app.member_date_extension',h.id::text,true);
  UPDATE public.member_membership_history SET term_end_date=p_new_end,membership_renewal_date=p_new_end+1 WHERE id=h.id;
  PERFORM set_config('app.member_date_extension','',true);
  RETURN jsonb_build_object('history_id',h.id,'audit_id',audit_id,'term_end_date',p_new_end);
END $$;
REVOKE ALL ON FUNCTION public.extend_member_date_term(uuid,uuid,uuid,date,date,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.extend_member_date_term(uuid,uuid,uuid,date,date,text,text) TO service_role;
COMMIT;

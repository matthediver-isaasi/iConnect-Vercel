BEGIN;
ALTER TABLE public.form ADD COLUMN IF NOT EXISTS date_membership_config_id uuid
  REFERENCES public.membership_tier_config(id);
CREATE TABLE public.form_date_membership_completion (
  submission_id uuid PRIMARY KEY REFERENCES public.form_submission(id),
  tenant_id uuid NOT NULL, member_id uuid NOT NULL,
  history_id uuid NOT NULL REFERENCES public.member_membership_history(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.form_date_membership_completion ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_date_membership_completion FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.form_date_membership_completion TO service_role;
CREATE POLICY service_only_date_completion ON public.form_date_membership_completion
  FOR ALL TO service_role USING(true) WITH CHECK(true);

CREATE FUNCTION public.guard_form_date_membership_config() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF (NEW.date_membership_config_id IS NOT NULL OR (TG_OP='UPDATE' AND OLD.date_membership_config_id IS NOT NULL))
    AND current_user<>'service_role' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
    RAISE EXCEPTION 'Date-based membership configuration requires the protected server path';
  END IF;
  IF NEW.date_membership_config_id IS NULL THEN RETURN NEW; END IF;
  IF to_jsonb(NEW)->>'form_type'='survey' OR coalesce((to_jsonb(NEW)->>'is_anonymous')::boolean,false)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(to_jsonb(NEW)->'fields','[]')) x
      WHERE x->>'type' IN ('payment','membership_payment')) THEN
    RAISE EXCEPTION 'No-charge submission membership cannot be combined with surveys or payment fields';
  END IF;
  PERFORM 1 FROM public.membership_tier_config WHERE id=NEW.date_membership_config_id
    AND tenant_id=NEW.tenant_id AND term_end_mode='member_date_field' AND structure_scope_type='member' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select a date-based member schedule belonging to this tenant'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER form_date_membership_config_guard BEFORE INSERT OR UPDATE ON public.form
  FOR EACH ROW EXECUTE FUNCTION public.guard_form_date_membership_config();

CREATE FUNCTION public.complete_form_date_membership() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE f public.form; cfg public.membership_tier_config; prior public.member_membership_history;
  end_value text; ends date; starts date := (now() AT TIME ZONE 'UTC')::date;
  field_value text; new_history uuid; saved public.form_date_membership_completion;
BEGIN
  SELECT * INTO f FROM public.form WHERE id=NEW.form_id AND tenant_id=NEW.tenant_id;
  IF f.date_membership_config_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO saved FROM public.form_date_membership_completion WHERE submission_id=NEW.id;
  IF FOUND THEN
    IF saved.member_id IS DISTINCT FROM NEW.created_member_id OR saved.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Membership completion identity cannot change';
    END IF;
    RETURN NEW;
  END IF;
  IF current_user<>'service_role' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
    IF NEW.entity_processing_completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Membership completion requires the protected submission processor';
    END IF;
    RETURN NEW;
  END IF;
  -- Enabling the feature must never backfill old, already-processed submissions.
  IF TG_OP='UPDATE' AND OLD.entity_processing_completed_at IS NOT NULL
    AND (NOT coalesce((to_jsonb(f)->>'due_diligence_required')::boolean,false)
      OR lower(coalesce(OLD.status,''))='approved'
      OR lower(coalesce(NEW.status,''))<>'approved') THEN RETURN NEW; END IF;
  IF NEW.entity_processing_completed_at IS NULL OR NEW.created_member_id IS NULL
    OR NEW.is_anonymous IS TRUE OR lower(coalesce(NEW.status,'')) IN ('rejected','declined','cancelled','spam','draft')
    OR (coalesce((to_jsonb(f)->>'due_diligence_required')::boolean,false) AND lower(coalesce(NEW.status,''))<>'approved') THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.member WHERE id=NEW.created_member_id AND tenant_id=NEW.tenant_id
    AND NOT coalesce(membership_paused,false) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Membership owner is unavailable or paused'; END IF;
  SELECT * INTO cfg FROM public.membership_tier_config WHERE id=f.date_membership_config_id
    AND tenant_id=NEW.tenant_id AND term_end_mode='member_date_field' AND is_active IS TRUE
    AND (effective_from IS NULL OR effective_from<=starts) AND (effective_to IS NULL OR effective_to>=starts) FOR SHARE;
  IF cfg.id IS NULL THEN RAISE EXCEPTION 'The configured membership schedule is not currently available'; END IF;
  IF cfg.structure_field_id IS NOT NULL THEN
    SELECT value INTO STRICT field_value FROM public.member_preference_value
      WHERE member_id=NEW.created_member_id AND field_id=cfg.structure_field_id;
    IF field_value IS DISTINCT FROM cfg.structure_match_value THEN
      RAISE EXCEPTION 'The submitted membership class does not match the selected schedule';
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.membership_billing_agreements WHERE tenant_id=NEW.tenant_id
    AND member_id=NEW.created_member_id AND status NOT IN ('cancelled','canceled','completed','expired')) THEN
    RAISE EXCEPTION 'An existing payment arrangement must be reviewed';
  END IF;
  SELECT value INTO STRICT end_value FROM public.member_preference_value
    WHERE member_id=NEW.created_member_id AND field_id=cfg.term_end_field_id;
  IF end_value IS NULL OR end_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'A valid membership end date is required';
  END IF;
  ends := end_value::date;
  IF ends<starts THEN RAISE EXCEPTION 'The membership end date has already passed'; END IF;
  -- Repeated forms may acknowledge the same active term, never extend it.
  SELECT * INTO prior FROM public.member_membership_history WHERE tenant_id=NEW.tenant_id AND member_id=NEW.created_member_id
    AND term_end_date>=starts AND status NOT IN ('expired_checkout','voided','cancelled')
    ORDER BY term_start_date DESC LIMIT 1;
  IF prior.id IS NOT NULL THEN
    IF prior.term_source_snapshot->>'type' IS DISTINCT FROM 'member_date_field'
      OR prior.config_id IS DISTINCT FROM cfg.id OR prior.term_end_date IS DISTINCT FROM ends OR prior.payment_status<>'paid' THEN
      RAISE EXCEPTION 'An active membership exists; changes require an administrator';
    END IF;
    new_history := prior.id;
  ELSE
    INSERT INTO public.member_membership_history(tenant_id,member_id,config_id,membership_year,tier_label,
      annual_cost,final_cost,total_with_vat,vat_amount,currency,billing_period,status,payment_status,paid_at,
      term_start_date,term_end_date,membership_renewal_date,term_source_snapshot,notes)
    VALUES(NEW.tenant_id,NEW.created_member_id,cfg.id,'member-date:'||starts||':'||ends,cfg.name,
      0,0,0,0,coalesce(cfg.currency,'GBP'),'annual','active','paid',now(),
      starts,ends,ends+1,jsonb_build_object('version',1,'type','member_date_field','tenant_id',NEW.tenant_id,
        'member_id',NEW.created_member_id,'field_id',cfg.term_end_field_id,'end_date',ends,
        'grace_days',coalesce(cfg.renewal_grace_days,0),'submission_id',NEW.id),
      'No-charge membership confirmed through form submission.')
    RETURNING id INTO new_history;
  END IF;
  INSERT INTO public.form_date_membership_completion(submission_id,tenant_id,member_id,history_id)
    VALUES(NEW.id,NEW.tenant_id,NEW.created_member_id,new_history);
  RETURN NEW;
END $$;
CREATE TRIGGER form_date_membership_completion AFTER INSERT OR UPDATE ON public.form_submission
  FOR EACH ROW EXECUTE FUNCTION public.complete_form_date_membership();
COMMIT;

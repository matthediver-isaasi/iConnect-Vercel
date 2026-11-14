BEGIN;
ALTER TABLE public.assessment_round
  ADD COLUMN moderation_proposers text[] NOT NULL DEFAULT ARRAY['chair'],
  ADD COLUMN moderation_approvers text[] NOT NULL DEFAULT ARRAY['approver'],
  ADD COLUMN moderation_discussion text[] NOT NULL DEFAULT ARRAY['chair','approver'],
  ADD CHECK(moderation_proposers <@ ARRAY['judge','chair','approver']::text[]),
  ADD CHECK(moderation_approvers <@ ARRAY['judge','chair','approver']::text[]),
  ADD CHECK(moderation_discussion <@ ARRAY['judge','chair','approver']::text[]);
CREATE TABLE public.assessment_panel_conflict (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  round_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  application_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('none','potential','confirmed','cleared')),
  reason text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  UNIQUE(appointment_id,application_id),
  FOREIGN KEY(tenant_id,round_id,appointment_id) REFERENCES public.assessment_appointment(tenant_id,round_id,id),
  FOREIGN KEY(tenant_id,application_id) REFERENCES public.awards_application(tenant_id,id)
);
ALTER TABLE public.assessment_panel_conflict ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assessment_panel_conflict FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.assessment_panel_conflict TO service_role;
ALTER TABLE public.assessment_moderation_revision ADD COLUMN actor_identity_keys text[] NOT NULL DEFAULT '{}';
CREATE FUNCTION public.assessment_actor_keys(p_tenant uuid,p_kind text,p_actor uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE keys text[]:=ARRAY[p_kind||':'||p_actor::text]; email text; person uuid;
BEGIN
  IF p_kind='member' THEN
    SELECT m.email INTO email FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id
      WHERE m.id=p_actor AND coalesce(m.tenant_id,o.tenant_id)=p_tenant;
  ELSIF p_kind='tenant_user' THEN
    SELECT u.email INTO email FROM public.tenant_user u WHERE u.id=p_actor AND u.tenant_id=p_tenant;
  ELSIF p_kind='appointment' THEN
    SELECT coalesce(m.email,c.email,j.external_email),j.member_id INTO email,person FROM public.assessment_appointment j
      LEFT JOIN public.member m ON m.id=j.member_id LEFT JOIN public.organization_contact c ON c.id=j.contact_id
      WHERE j.tenant_id=p_tenant AND j.id=p_actor;
    IF person IS NOT NULL THEN keys:=keys||ARRAY['member:'||person::text]; END IF;
  END IF;
  IF length(btrim(coalesce(email,'')))>0 THEN
    keys:=keys||ARRAY['email:'||encode(sha256(convert_to(lower(btrim(email)),'UTF8')),'hex')];
  END IF;
  RETURN keys;
END $$;
CREATE FUNCTION public.assessment_record_actor_keys() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
  NEW.actor_identity_keys:=public.assessment_actor_keys(NEW.tenant_id,NEW.actor_kind,NEW.actor_id);
  RETURN NEW;
END $$;
CREATE FUNCTION public.assessment_actor_conflicted(p_tenant uuid,p_round uuid,p_application uuid,p_keys text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.assessment_appointment j WHERE j.tenant_id=p_tenant AND j.round_id=p_round
    AND p_keys && public.assessment_actor_keys(p_tenant,'appointment',j.id)
    AND (EXISTS(SELECT 1 FROM public.assessment_panel_conflict c WHERE c.appointment_id=j.id AND c.application_id=p_application AND c.state IN ('potential','confirmed'))
      OR EXISTS(SELECT 1 FROM public.assessment_assignment s WHERE s.appointment_id=j.id AND s.application_id=p_application AND s.conflict IN ('potential','confirmed'))));
$$;
CREATE TRIGGER assessment_record_actor_keys BEFORE INSERT ON public.assessment_moderation_revision
FOR EACH ROW EXECUTE FUNCTION public.assessment_record_actor_keys();
CREATE FUNCTION public.assessment_panel_authority(p_tenant uuid,p_round uuid,p_member uuid,p_session_hash text,p_csrf_hash text,p_mutate boolean)
RETURNS public.assessment_appointment LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE authority jsonb; appointment public.assessment_appointment;
BEGIN
  IF num_nonnulls(p_member,p_session_hash)<>1 THEN RAISE EXCEPTION 'Panel authority required' USING ERRCODE='42501'; END IF;
  IF p_member IS NULL THEN authority:=public.assessment_session_authority(p_tenant,p_session_hash); END IF;
  SELECT * INTO appointment FROM public.assessment_appointment
    WHERE tenant_id=p_tenant AND round_id=p_round
      AND (member_id=p_member OR id=(authority->>'appointment_id')::uuid) FOR UPDATE;
  IF NOT FOUND OR appointment.state<>'accepted' OR appointment.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Panel appointment unavailable' USING ERRCODE='42501'; END IF;
  -- Recheck after taking the appointment lock, including credential rotation.
  IF p_member IS NULL THEN
    authority:=public.assessment_session_authority(p_tenant,p_session_hash);
    IF p_mutate AND (authority->>'csrf_hash') IS DISTINCT FROM p_csrf_hash THEN
      RAISE EXCEPTION 'Panel request verification failed' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN appointment;
END $$;
REVOKE ALL ON FUNCTION public.assessment_actor_keys(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_record_actor_keys() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_actor_conflicted(uuid,uuid,uuid,text[]) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_panel_authority(uuid,uuid,uuid,text,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;

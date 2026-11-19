-- Forward-only, application-coordinated rollout. Do not apply while old award
-- workers are running. No legacy assignments, grants or PDFs are converted.
BEGIN;

ALTER TABLE public.event_agenda_item
  ADD COLUMN IF NOT EXISTS speaker_award_config jsonb,
  ADD COLUMN IF NOT EXISTS speaker_awards_error text,
  ADD COLUMN IF NOT EXISTS speaker_awards_granted_at timestamptz,
  ADD COLUMN IF NOT EXISTS speaker_recognition_processed_at timestamptz;
ALTER TABLE public.event ADD COLUMN IF NOT EXISTS speaker_scope_ready boolean NOT NULL DEFAULT false;
ALTER TABLE public.event ADD COLUMN IF NOT EXISTS speaker_scope_attempted_at timestamptz;
ALTER TABLE public.speaker_award_grant
  ADD COLUMN IF NOT EXISTS agenda_item_id uuid,
  ADD COLUMN IF NOT EXISTS agenda_snapshot jsonb;
ALTER TABLE public.speaker_recognition
  ADD COLUMN IF NOT EXISTS agenda_item_id uuid;
ALTER TABLE public.speaker_award_grant ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.speaker_award_grant FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.speaker_award_grant TO service_role;

-- Deliberately no cascading agenda FK: deleting a line must not destroy
-- financial or issuance evidence. Scope ownership is checked below instead.
ALTER TABLE public.speaker_award_grant
  DROP CONSTRAINT IF EXISTS speaker_award_grant_event_type_event_id_speaker_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS speaker_award_grant_legacy_identity
  ON public.speaker_award_grant(event_type,event_id,speaker_id) WHERE agenda_item_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS speaker_award_grant_agenda_identity
  ON public.speaker_award_grant(tenant_id,event_id,agenda_item_id,speaker_id) WHERE agenda_item_id IS NOT NULL;
ALTER TABLE public.speaker_recognition
  DROP CONSTRAINT IF EXISTS speaker_recognition_tenant_id_event_type_event_id_speaker_id_key;
ALTER TABLE public.speaker_recognition
  DROP CONSTRAINT IF EXISTS speaker_recognition_tenant_id_event_type_event_id_speaker_i_key;
CREATE UNIQUE INDEX IF NOT EXISTS speaker_recognition_legacy_identity
  ON public.speaker_recognition(tenant_id,event_type,event_id,speaker_id) WHERE agenda_item_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS speaker_recognition_agenda_identity
  ON public.speaker_recognition(tenant_id,event_id,agenda_item_id,speaker_id) WHERE agenda_item_id IS NOT NULL;

CREATE TABLE public.training_speaker_scope_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  starts_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.training_speaker_scope_policy(singleton) VALUES(true);
ALTER TABLE public.training_speaker_scope_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.training_speaker_scope_policy FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.training_speaker_scope_policy TO service_role;

-- Stable identity cannot be moved to another tenant/parent, even via generic
-- entity writes. Parent row locking is shared with scoped processing.
CREATE FUNCTION public.validate_training_speaker_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.event; sid text;
BEGIN
  IF TG_TABLE_NAME='event' THEN
    -- Explicit inputs only. Booking capacity, cancellations, search indexing
    -- and other operational updates must not suspend finalized appearances.
    IF TG_OP='INSERT' OR (NEW.is_training,NEW.status,NEW.event_state,NEW.timezone,to_jsonb(NEW.speaker_ids),NEW.speaker_award_config)
      IS DISTINCT FROM (OLD.is_training,OLD.status,OLD.event_state,OLD.timezone,to_jsonb(OLD.speaker_ids),OLD.speaker_award_config) THEN
      NEW.speaker_scope_ready:=false;
    END IF;
    IF NEW.is_training AND (
      (TG_OP='INSERT' AND jsonb_array_length(COALESCE(to_jsonb(NEW.speaker_ids),'[]'))>0)
      OR (TG_OP='UPDATE' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(to_jsonb(NEW.speaker_ids),'[]')) n
        WHERE NOT COALESCE(to_jsonb(OLD.speaker_ids),'[]') ? n
      ))) THEN
      RAISE EXCEPTION 'Training speakers must be assigned to agenda items; existing event speakers require manual allocation' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.event_id,NEW.id) IS DISTINCT FROM
    (OLD.tenant_id,OLD.event_id,OLD.id) THEN
    RAISE EXCEPTION 'Agenda identity and parent are immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO e FROM public.event WHERE id=NEW.event_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agenda parent does not belong to tenant' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' OR (to_jsonb(NEW.speaker_ids),NEW.speaker_award_config,NEW.start_date,NEW.start_time,NEW.end_date,NEW.end_time,NEW.description)
    IS DISTINCT FROM (to_jsonb(OLD.speaker_ids),OLD.speaker_award_config,OLD.start_date,OLD.start_time,OLD.end_date,OLD.end_time,OLD.description) THEN
    UPDATE public.event SET speaker_scope_ready=false WHERE id=e.id AND e.is_training;
  END IF;
  FOR sid IN SELECT jsonb_array_elements_text(COALESCE(to_jsonb(NEW.speaker_ids),'[]')) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.speaker WHERE id::text=sid AND tenant_id=NEW.tenant_id) THEN
      RAISE EXCEPTION 'Agenda speaker does not belong to tenant' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_training_speaker_scope BEFORE INSERT OR UPDATE ON public.event_agenda_item
FOR EACH ROW EXECUTE FUNCTION public.validate_training_speaker_scope();
CREATE TRIGGER validate_training_event_speakers BEFORE INSERT OR UPDATE ON public.event
FOR EACH ROW EXECUTE FUNCTION public.validate_training_speaker_scope();
CREATE TRIGGER validate_agenda_speaker_certificate_config BEFORE INSERT OR UPDATE ON public.event_agenda_item
FOR EACH ROW EXECUTE FUNCTION public.validate_speaker_certificate_config();

-- Fence old workers at the durable claim boundary, not just in the new cron.
-- Existing historical event-level records remain readable and immutable in scope.
CREATE FUNCTION public.guard_speaker_award_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.event_type,NEW.event_id,NEW.speaker_id,NEW.agenda_item_id)
    IS DISTINCT FROM (OLD.tenant_id,OLD.event_type,OLD.event_id,OLD.speaker_id,OLD.agenda_item_id) THEN
    RAISE EXCEPTION 'Speaker award scope is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.agenda_item_id IS NOT NULL THEN
    IF NEW.event_type<>'event' OR NOT EXISTS (
      SELECT 1 FROM public.event_agenda_item a JOIN public.event e ON e.id=a.event_id AND e.tenant_id=a.tenant_id
      WHERE a.id=NEW.agenda_item_id AND a.event_id=NEW.event_id AND a.tenant_id=NEW.tenant_id AND e.is_training
    ) THEN
      -- Historical rows can still be cancelled / have delivery stamps recorded
      -- after line deletion, but may not acquire a new processing identity.
      IF TG_OP='INSERT' THEN RAISE EXCEPTION 'Invalid agenda award scope' USING ERRCODE='23514'; END IF;
    END IF;
  ELSIF TG_OP='INSERT' AND NEW.event_type='event' AND EXISTS (
    SELECT 1 FROM public.event WHERE id=NEW.event_id AND tenant_id=NEW.tenant_id AND is_training
  ) THEN RAISE EXCEPTION 'Event-wide training awards are disabled' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_speaker_award_scope BEFORE INSERT OR UPDATE ON public.speaker_award_grant
FOR EACH ROW EXECUTE FUNCTION public.guard_speaker_award_scope();
CREATE TRIGGER guard_speaker_recognition_scope BEFORE INSERT OR UPDATE ON public.speaker_recognition
FOR EACH ROW EXECUTE FUNCTION public.guard_speaker_award_scope();

-- One ordered union for summaries only. Never use this as an award identity.
CREATE FUNCTION public.training_speaker_ids(p_tenant uuid,p_event uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT COALESCE(jsonb_agg(id ORDER BY first_line,line_id,first_position,id),'[]') FROM (
    SELECT DISTINCT ON (ids.id) ids.id,a.sort_order first_line,a.id line_id,ids.ordinality first_position
    FROM public.event_agenda_item a
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(to_jsonb(a.speaker_ids),'[]')) WITH ORDINALITY ids(id,ordinality)
    JOIN public.speaker s ON s.id::text=ids.id AND s.tenant_id=p_tenant
    WHERE a.event_id=p_event AND a.tenant_id=p_tenant ORDER BY ids.id,a.sort_order,a.id,ids.ordinality
  ) ordered
$$;

REVOKE ALL ON FUNCTION public.validate_training_speaker_scope(),public.guard_speaker_award_scope(),
  public.training_speaker_ids(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.training_speaker_ids(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

-- SEPARATE approval required. Do not include in the six approved scope migrations.
-- Initially open; no worker is paused by installation. No historical rows change.
BEGIN;
CREATE TABLE public.speaker_rollout_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  phase text NOT NULL DEFAULT 'open' CHECK (phase IN ('open','draining','paused')),
  generation bigint NOT NULL DEFAULT 0,
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.speaker_rollout_control(singleton) VALUES(true);
CREATE TABLE public.speaker_rollout_operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation bigint NOT NULL,
  kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 100),
  deployment text NOT NULL CHECK(length(deployment) BETWEEN 1 AND 300),
  revision text NOT NULL CHECK(length(revision) BETWEEN 1 AND 100),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  failed boolean
);
CREATE INDEX speaker_rollout_unfinished ON public.speaker_rollout_operation(started_at)
  WHERE finished_at IS NULL;
CREATE TABLE public.speaker_rollout_transition (
  generation bigint PRIMARY KEY,
  phase text NOT NULL,
  note text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.speaker_rollout_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.speaker_rollout_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.speaker_rollout_transition ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.speaker_rollout_control, public.speaker_rollout_operation,
  public.speaker_rollout_transition FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.speaker_rollout_control, public.speaker_rollout_operation,
  public.speaker_rollout_transition TO service_role;
CREATE POLICY speaker_rollout_control_read ON public.speaker_rollout_control
  FOR SELECT TO service_role USING(true);
CREATE POLICY speaker_rollout_operation_read ON public.speaker_rollout_operation
  FOR SELECT TO service_role USING(true);
CREATE POLICY speaker_rollout_transition_read ON public.speaker_rollout_transition
  FOR SELECT TO service_role USING(true);

CREATE FUNCTION public.begin_speaker_rollout_operation(p_kind text,p_deployment text,p_revision text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE gate public.speaker_rollout_control; result uuid;
BEGIN
  SELECT * INTO STRICT gate FROM public.speaker_rollout_control WHERE singleton FOR SHARE;
  IF gate.phase <> 'open' THEN
    RAISE EXCEPTION USING ERRCODE='PT503', MESSAGE='Speaker rollout maintenance';
  END IF;
  INSERT INTO public.speaker_rollout_operation(generation,kind,deployment,revision)
    VALUES(gate.generation,p_kind,p_deployment,p_revision) RETURNING id INTO result;
  RETURN result;
END $$;
CREATE FUNCTION public.finish_speaker_rollout_operation(p_id uuid,p_failed boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_failed IS NULL THEN RAISE EXCEPTION 'Completion outcome is required'; END IF;
  UPDATE public.speaker_rollout_operation SET finished_at=clock_timestamp(),failed=p_failed
    WHERE id=p_id AND finished_at IS NULL;
  RETURN FOUND;
END $$;

-- Operator-only: service_role cannot change phase or certify a drain.
-- The required note must reference deployment coverage and external-flight checks.
CREATE FUNCTION public.set_speaker_rollout_phase(p_phase text,p_expected_generation bigint,p_note text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE gate public.speaker_rollout_control; next_generation bigint;
BEGIN
  IF p_note IS NULL OR length(trim(p_note)) < 10 THEN RAISE EXCEPTION 'Operator evidence note required'; END IF;
  SELECT * INTO STRICT gate FROM public.speaker_rollout_control WHERE singleton FOR UPDATE;
  IF gate.generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='Rollout generation changed';
  END IF;
  IF p_phase IS NULL OR NOT (
    (gate.phase='open' AND p_phase='draining') OR
    (gate.phase='draining' AND p_phase IN ('paused','open')) OR
    (gate.phase='paused' AND p_phase='open')
  ) THEN RAISE EXCEPTION 'Invalid rollout transition'; END IF;
  IF p_phase='paused' AND EXISTS (
    SELECT 1 FROM public.speaker_rollout_operation WHERE finished_at IS NULL
  ) THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='Unfinished speaker operations remain'; END IF;
  next_generation := gate.generation+1;
  UPDATE public.speaker_rollout_control SET phase=p_phase,generation=next_generation,
    changed_at=clock_timestamp() WHERE singleton;
  INSERT INTO public.speaker_rollout_transition(generation,phase,note)
    VALUES(next_generation,p_phase,p_note);
  RETURN next_generation;
END $$;

-- Shared row locks last for the entire writer transaction. The exclusive pause
-- transition waits for these writers; subsequent writes observe paused and fail.
-- This also fences legacy SQL/RPC writers, not just the new application wrappers.
CREATE FUNCTION public.guard_speaker_rollout_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE phase_value text; relevant boolean;
BEGIN
  relevant := TG_OP <> 'UPDATE' OR TG_NARGS=0;
  IF NOT relevant THEN
    FOR i IN 0..TG_NARGS-1 LOOP
      IF (to_jsonb(OLD)->TG_ARGV[i]) IS DISTINCT FROM (to_jsonb(NEW)->TG_ARGV[i]) THEN
        relevant := true; EXIT;
      END IF;
    END LOOP;
  END IF;
  IF relevant THEN
    SELECT phase INTO STRICT phase_value FROM public.speaker_rollout_control
      WHERE singleton FOR SHARE;
    IF phase_value='paused' THEN
      RAISE EXCEPTION USING ERRCODE='PT503',
        MESSAGE='Speaker-related changes are temporarily paused for maintenance';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER speaker_rollout_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.event
  FOR EACH ROW EXECUTE FUNCTION public.guard_speaker_rollout_write(
    'is_training','speaker_ids','speaker_award_config','start_date','end_date',
    'timezone','status','event_state','title','tenant_id','speaker_scope_ready',
    'speaker_scope_attempted_at','speaker_awards_granted_at','zoom_webinar_id','zoom_meeting_id');
CREATE TRIGGER speaker_rollout_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.complex_event
  FOR EACH ROW EXECUTE FUNCTION public.guard_speaker_rollout_write(
    'speaker_award_config','start_date','end_date','timezone','status','event_state','title','tenant_id',
    'speaker_awards_granted_at','zoom_webinar_id','zoom_meeting_id');
CREATE TRIGGER speaker_rollout_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.complex_event_session
  FOR EACH ROW EXECUTE FUNCTION public.guard_speaker_rollout_write();
CREATE TRIGGER speaker_rollout_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.event_agenda_item
  FOR EACH ROW EXECUTE FUNCTION public.guard_speaker_rollout_write();
CREATE TRIGGER speaker_rollout_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.speaker
  FOR EACH ROW EXECUTE FUNCTION public.guard_speaker_rollout_write();
CREATE TRIGGER speaker_rollout_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.speaker_award_grant
  FOR EACH ROW EXECUTE FUNCTION public.guard_speaker_rollout_write();
CREATE TRIGGER speaker_rollout_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.speaker_recognition
  FOR EACH ROW EXECUTE FUNCTION public.guard_speaker_rollout_write();
REVOKE ALL ON FUNCTION public.begin_speaker_rollout_operation(text,text,text),
  public.finish_speaker_rollout_operation(uuid,boolean),
  public.set_speaker_rollout_phase(text,bigint,text),
  public.guard_speaker_rollout_write() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_speaker_rollout_operation(text,text,text),
  public.finish_speaker_rollout_operation(uuid,boolean) TO service_role;
COMMIT;

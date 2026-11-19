BEGIN;
CREATE FUNCTION public.prune_training_speaker_references() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.event_agenda_item a SET speaker_ids=(
    jsonb_populate_record(NULL::public.event_agenda_item,jsonb_build_object('speaker_ids',
      (SELECT COALESCE(jsonb_agg(sid),'[]') FROM jsonb_array_elements_text(COALESCE(to_jsonb(a.speaker_ids),'[]')) sid
        WHERE sid<>OLD.id::text)))
  ).speaker_ids
  WHERE a.tenant_id=OLD.tenant_id AND COALESCE(to_jsonb(a.speaker_ids),'[]') ? OLD.id::text;
  UPDATE public.speaker_award_grant SET status='cancelled',
    detail=COALESCE(detail||'; ','')||'Speaker deleted; historical effects retained'
    WHERE tenant_id=OLD.tenant_id AND speaker_id=OLD.id AND agenda_item_id IS NOT NULL
      AND status IN ('pending','granted');
  RETURN OLD;
END $$;
CREATE TRIGGER prune_training_speaker_references BEFORE DELETE ON public.speaker
FOR EACH ROW EXECUTE FUNCTION public.prune_training_speaker_references();
REVOKE ALL ON FUNCTION public.prune_training_speaker_references() FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.validate_training_speaker_dates() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.event; a public.event_agenda_item; starts timestamptz; ends timestamptz;
BEGIN
  IF TG_TABLE_NAME='event' THEN
    IF NOT NEW.is_training OR (TG_OP='UPDATE' AND NEW.timezone IS NOT DISTINCT FROM OLD.timezone) THEN RETURN NEW; END IF;
    FOR a IN SELECT * FROM public.event_agenda_item WHERE event_id=NEW.id AND tenant_id=NEW.tenant_id LOOP
      starts:=public.speaker_agenda_instant(a.start_date,a.start_time,NEW.timezone);
      ends:=public.speaker_agenda_instant(COALESCE(a.end_date,a.start_date),a.end_time,NEW.timezone,true);
      IF ends<starts THEN RAISE EXCEPTION 'Agenda end precedes start' USING ERRCODE='23514'; END IF;
    END LOOP;
  ELSE
    IF TG_OP='UPDATE' AND (NEW.id,NEW.tenant_id,NEW.event_id) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.event_id) THEN
      RAISE EXCEPTION 'Agenda identity and parent are immutable' USING ERRCODE='23514';
    END IF;
    SELECT * INTO e FROM public.event WHERE id=NEW.event_id AND tenant_id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Agenda parent does not belong to tenant' USING ERRCODE='23514'; END IF;
    IF NOT e.is_training THEN RETURN NEW; END IF;
    starts:=public.speaker_agenda_instant(NEW.start_date,NEW.start_time,e.timezone);
    ends:=public.speaker_agenda_instant(COALESCE(NEW.end_date,NEW.start_date),NEW.end_time,e.timezone,true);
    IF ends<starts THEN RAISE EXCEPTION 'Agenda end precedes start' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_training_speaker_dates BEFORE INSERT OR UPDATE ON public.event_agenda_item
FOR EACH ROW EXECUTE FUNCTION public.validate_training_speaker_dates();
CREATE TRIGGER validate_training_speaker_dates BEFORE INSERT OR UPDATE OF timezone,is_training ON public.event
FOR EACH ROW EXECUTE FUNCTION public.validate_training_speaker_dates();
REVOKE ALL ON FUNCTION public.validate_training_speaker_dates() FROM PUBLIC,anon,authenticated;
-- Deferred so an atomic parent+agenda save can allocate onto newly inserted
-- lines. A stale generic parent PATCH cannot silently discard the backlog.
CREATE FUNCTION public.require_manual_training_speaker_allocation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE sid text;
BEGIN
  IF NOT OLD.is_training OR NOT NEW.is_training THEN RETURN NULL; END IF;
  FOR sid IN SELECT jsonb_array_elements_text(COALESCE(to_jsonb(OLD.speaker_ids),'[]')) LOOP
    IF NOT COALESCE(to_jsonb(NEW.speaker_ids),'[]') ? sid
      AND EXISTS(SELECT 1 FROM public.speaker WHERE tenant_id=NEW.tenant_id AND id::text=sid)
      AND NOT EXISTS(SELECT 1 FROM public.event_agenda_item WHERE tenant_id=NEW.tenant_id AND event_id=NEW.id
        AND COALESCE(to_jsonb(speaker_ids),'[]') ? sid) THEN
      RAISE EXCEPTION 'Legacy training speaker needs allocation to an agenda item before removal from the backlog' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER require_manual_training_speaker_allocation AFTER UPDATE ON public.event
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_manual_training_speaker_allocation();
REVOKE ALL ON FUNCTION public.require_manual_training_speaker_allocation() FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;

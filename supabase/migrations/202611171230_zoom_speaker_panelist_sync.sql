BEGIN;
CREATE TABLE public.zoom_speaker_sync (
  webinar_id uuid PRIMARY KEY REFERENCES public.zoom_webinar(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  generation bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','attention')),
  managed jsonb NOT NULL DEFAULT '{}',
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  summary jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.zoom_speaker_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zoom_speaker_sync FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.zoom_speaker_sync TO service_role;

CREATE FUNCTION public.queue_zoom_speakers(p_tenant uuid,p_webinar text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE w uuid;
BEGIN
  IF p_webinar IS NULL OR p_webinar='' THEN RETURN; END IF;
  SELECT id INTO w FROM public.zoom_webinar
    WHERE tenant_id=p_tenant AND (id::text=p_webinar OR zoom_webinar_id::text=p_webinar)
    ORDER BY id LIMIT 1;
  IF w IS NULL THEN RETURN; END IF;
  INSERT INTO public.zoom_speaker_sync(webinar_id,tenant_id) VALUES(w,p_tenant)
  ON CONFLICT(webinar_id) DO UPDATE SET generation=zoom_speaker_sync.generation+1,
    status='pending',next_attempt_at=now(),last_error=NULL,updated_at=now();
END $$;

-- A complete desired set includes every event/session sharing this webinar.
-- Missing speakers stay in the result, preventing destructive reconciliation.
CREATE FUNCTION public.zoom_speaker_desired(p_tenant uuid,p_webinar uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH w AS (SELECT * FROM public.zoom_webinar WHERE id=p_webinar AND tenant_id=p_tenant),
 ids AS (
   SELECT unnest(e.speaker_ids)::text id FROM public.event e,w
     WHERE e.tenant_id=p_tenant AND e.zoom_webinar_id=w.id
   UNION
   SELECT unnest(s.speaker_ids)::text FROM public.complex_event_session s,w
     WHERE s.tenant_id=p_tenant AND s.zoom_webinar_id::text IN(w.id::text,w.zoom_webinar_id::text)
   UNION
   SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.speaker_ids)='array' THEN a.speaker_ids ELSE '[]'::jsonb END)
     FROM public.event_agenda_item a JOIN public.event e ON e.id=a.event_id AND e.tenant_id=a.tenant_id,w
     WHERE a.tenant_id=p_tenant AND (a.zoom_webinar_id=w.id OR (a.zoom_webinar_id IS NULL AND e.zoom_webinar_id=w.id))
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',ids.id,'name',s.full_name,'email',s.email,'found',s.id IS NOT NULL)
   ORDER BY ids.id),'[]'::jsonb) FROM ids LEFT JOIN public.speaker s ON s.id::text=ids.id AND s.tenant_id=p_tenant;
$$;

CREATE FUNCTION public.queue_zoom_speaker_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE doc jsonb; olddoc jsonb; r record; parent record;
BEGIN
  IF TG_OP<>'DELETE' THEN doc:=to_jsonb(NEW); END IF;
  IF TG_OP<>'INSERT' THEN olddoc:=to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME='speaker' THEN
    IF TG_OP='UPDATE' AND (doc->'email',doc->'full_name') IS NOT DISTINCT FROM
      (olddoc->'email',olddoc->'full_name') THEN RETURN NEW; END IF;
    FOR r IN SELECT z.id,z.tenant_id FROM public.zoom_webinar z
      WHERE z.tenant_id=(coalesce(doc,olddoc)->>'tenant_id')::uuid
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(public.zoom_speaker_desired(z.tenant_id,z.id)) x
        WHERE x->>'id'=coalesce(doc,olddoc)->>'id')
    LOOP PERFORM public.queue_zoom_speakers(r.tenant_id,r.id::text); END LOOP;
  ELSE
    IF TG_OP='UPDATE' AND (doc->'speaker_ids',doc->'zoom_webinar_id',doc->'event_id') IS NOT DISTINCT FROM
      (olddoc->'speaker_ids',olddoc->'zoom_webinar_id',olddoc->'event_id') THEN RETURN NEW; END IF;
    FOR r IN SELECT DISTINCT x->>'tenant_id' tenant,x->>'zoom_webinar_id' webinar,x->>'event_id' parent
      FROM jsonb_array_elements(jsonb_build_array(doc,olddoc)) x WHERE x<>'null'::jsonb
    LOOP
      PERFORM public.queue_zoom_speakers(r.tenant::uuid,r.webinar);
      IF TG_TABLE_NAME='event_agenda_item' AND r.parent IS NOT NULL THEN
        FOR parent IN SELECT tenant_id,zoom_webinar_id FROM public.event WHERE id=r.parent::uuid AND tenant_id=r.tenant::uuid
        LOOP PERFORM public.queue_zoom_speakers(parent.tenant_id,parent.zoom_webinar_id::text); END LOOP;
      END IF;
    END LOOP;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER event_zoom_speaker_queue AFTER INSERT OR UPDATE OR DELETE ON public.event
FOR EACH ROW EXECUTE FUNCTION public.queue_zoom_speaker_source();
CREATE TRIGGER session_zoom_speaker_queue AFTER INSERT OR UPDATE OR DELETE ON public.complex_event_session
FOR EACH ROW EXECUTE FUNCTION public.queue_zoom_speaker_source();
CREATE TRIGGER agenda_zoom_speaker_queue AFTER INSERT OR UPDATE OR DELETE ON public.event_agenda_item
FOR EACH ROW EXECUTE FUNCTION public.queue_zoom_speaker_source();
CREATE TRIGGER speaker_zoom_speaker_queue AFTER UPDATE OR DELETE ON public.speaker
FOR EACH ROW EXECUTE FUNCTION public.queue_zoom_speaker_source();

CREATE FUNCTION public.claim_zoom_speaker_sync(p_tenant uuid DEFAULT NULL,p_webinar uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.zoom_speaker_sync; w public.zoom_webinar;
BEGIN
  SELECT * INTO j FROM public.zoom_speaker_sync
    WHERE status IN ('pending','running') AND next_attempt_at<=now()
    AND (lease_until IS NULL OR lease_until<now())
    AND (p_tenant IS NULL OR tenant_id=p_tenant) AND (p_webinar IS NULL OR webinar_id=p_webinar)
    ORDER BY next_attempt_at,webinar_id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE public.zoom_speaker_sync SET status='running',lease_token=gen_random_uuid(),
    lease_until=now()+interval '90 seconds',updated_at=now()
    WHERE webinar_id=j.webinar_id RETURNING * INTO j;
  SELECT * INTO w FROM public.zoom_webinar WHERE id=j.webinar_id AND tenant_id=j.tenant_id;
  RETURN to_jsonb(j)||jsonb_build_object('provider_id',w.zoom_webinar_id,
    'duplicate_targets',(SELECT count(*)>1 FROM public.zoom_webinar z WHERE z.tenant_id=j.tenant_id AND z.zoom_webinar_id=w.zoom_webinar_id),
    'start_time',w.start_time,'webinar_status',w.status,
    'desired',public.zoom_speaker_desired(j.tenant_id,j.webinar_id));
END $$;

-- Checkpoints require the same worker lease. A source edit prevents further
-- writes, but an in-flight provider result must still be recorded for recovery.
CREATE FUNCTION public.checkpoint_zoom_speaker_sync(
 p_webinar uuid,p_tenant uuid,p_token uuid,p_generation bigint,p_patch jsonb,p_fence boolean DEFAULT false
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.zoom_speaker_sync; done boolean; item record;
BEGIN
 SELECT * INTO j FROM public.zoom_speaker_sync WHERE webinar_id=p_webinar AND tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND OR j.lease_token IS DISTINCT FROM p_token OR j.lease_until<=now() THEN RETURN false; END IF;
 IF p_fence THEN
   IF j.generation<>p_generation THEN RETURN false; END IF;
   UPDATE public.zoom_speaker_sync SET lease_until=now()+interval '90 seconds' WHERE webinar_id=p_webinar;
   RETURN true;
 END IF;
 done:=p_patch ? 'status';
 IF p_patch ? 'managed' THEN
   -- Mirror only entries that this reconciler demonstrably created.
   FOR item IN SELECT key,value FROM jsonb_each(j.managed) LOOP
     IF item.value->>'owned'='true' AND NOT coalesce(p_patch->'managed' ? item.key,false) THEN
       DELETE FROM public.zoom_webinar_panelist WHERE webinar_id=p_webinar
         AND zoom_panelist_id=item.value->>'id';
     END IF;
   END LOOP;
   FOR item IN SELECT key,value FROM jsonb_each(p_patch->'managed') LOOP
     IF item.value->>'owned'='true' AND item.value->>'id' IS NOT NULL THEN
       INSERT INTO public.zoom_webinar_panelist(webinar_id,name,email,role,zoom_panelist_id,status)
         SELECT p_webinar,item.value->>'name',item.key,'panelist',item.value->>'id','invited'
         WHERE NOT EXISTS(SELECT 1 FROM public.zoom_webinar_panelist
           WHERE webinar_id=p_webinar AND zoom_panelist_id=item.value->>'id');
     END IF;
   END LOOP;
 END IF;
 UPDATE public.zoom_speaker_sync SET
   managed=coalesce(p_patch->'managed',managed),
   summary=coalesce(p_patch->'summary',summary),
   last_error=p_patch->>'error',
   status=CASE WHEN NOT done THEN status WHEN generation<>p_generation THEN 'pending' ELSE p_patch->>'status' END,
   lease_until=CASE WHEN done THEN NULL ELSE lease_until END,
   lease_token=CASE WHEN done THEN NULL ELSE lease_token END,
   next_attempt_at=CASE WHEN generation<>p_generation THEN now()
     WHEN p_patch->>'status'='pending' THEN now()+interval '1 minute' ELSE next_attempt_at END,
   updated_at=now()
 WHERE webinar_id=p_webinar;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.queue_zoom_speakers(uuid,text),
 public.zoom_speaker_desired(uuid,uuid),public.queue_zoom_speaker_source(),
 public.claim_zoom_speaker_sync(uuid,uuid),
 public.checkpoint_zoom_speaker_sync(uuid,uuid,uuid,bigint,jsonb,boolean)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.queue_zoom_speakers(uuid,text),public.claim_zoom_speaker_sync(uuid,uuid),
 public.checkpoint_zoom_speaker_sync(uuid,uuid,uuid,bigint,jsonb,boolean) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

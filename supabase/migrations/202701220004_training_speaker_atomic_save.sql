BEGIN;
-- Called only after the existing generic Event PATCH has run its complete
-- authorization/validation pipeline. Parent + complete agenda commit together.
CREATE FUNCTION public.save_training_event_agenda(p_tenant uuid,p_event uuid,p_parent jsonb,p_lines jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.event; a public.event_agenda_item; doc jsonb; line jsonb; columns text; saved uuid[]:='{}'; lid uuid;
BEGIN
  SELECT * INTO e FROM public.event WHERE tenant_id=p_tenant AND id=p_event FOR UPDATE;
  IF NOT FOUND OR NOT COALESCE((p_parent->>'is_training')::boolean,e.is_training) THEN
    RAISE EXCEPTION 'Training event not found';
  END IF;
  IF jsonb_typeof(p_parent)<>'object' OR jsonb_typeof(p_lines)<>'array' OR p_parent ?| ARRAY[
    'id','tenant_id','created_at','speaker_scope_ready','speaker_awards_granted_at','speaker_recognition_processed_at'
  ] THEN RAISE EXCEPTION 'Invalid training save payload'; END IF;
  SELECT string_agg(format('%I',key),',') INTO columns FROM jsonb_object_keys(p_parent) key
    WHERE EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.event'::regclass AND attname=key AND attnum>0 AND NOT attisdropped);
  IF columns IS NOT NULL THEN
    EXECUTE format('UPDATE public.event SET (%s)=(SELECT %s FROM jsonb_populate_record(NULL::public.event,$1)) WHERE id=$2 AND tenant_id=$3',
      columns,columns) USING to_jsonb(e)||p_parent,p_event,p_tenant;
  END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    lid:=COALESCE(NULLIF(line->>'id','')::uuid,gen_random_uuid());
    IF lid=ANY(saved) THEN RAISE EXCEPTION 'Duplicate agenda identity'; END IF;
    SELECT * INTO a FROM public.event_agenda_item WHERE id=lid;
    IF FOUND AND (a.tenant_id,a.event_id) IS DISTINCT FROM (p_tenant,p_event) THEN
      RAISE EXCEPTION 'Agenda identity belongs to another event' USING ERRCODE='23514';
    END IF;
    doc:=COALESCE(to_jsonb(a),'{}')||line||jsonb_build_object('id',lid,'tenant_id',p_tenant,'event_id',p_event);
    -- Metadata never comes from an editor or a duplicate.
    doc:=doc||jsonb_build_object('speaker_awards_granted_at',a.speaker_awards_granted_at,
      'speaker_recognition_processed_at',a.speaker_recognition_processed_at);
    IF a.id IS NULL THEN
      doc:=doc||jsonb_build_object('created_at',now(),'updated_at',now());
      INSERT INTO public.event_agenda_item SELECT * FROM jsonb_populate_record(NULL::public.event_agenda_item,doc);
    ELSE
      SELECT string_agg(format('%I',key),',') INTO columns FROM jsonb_object_keys(line) key
        WHERE key NOT IN ('id','tenant_id','event_id','created_at','speaker_awards_granted_at','speaker_recognition_processed_at')
        AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.event_agenda_item'::regclass AND attname=key AND attnum>0 AND NOT attisdropped);
      IF columns IS NOT NULL THEN
        EXECUTE format('UPDATE public.event_agenda_item SET (%s)=(SELECT %s FROM jsonb_populate_record(NULL::public.event_agenda_item,$1)) WHERE id=$2',
          columns,columns) USING doc,lid;
      END IF;
    END IF;
    saved:=array_append(saved,lid);
  END LOOP;
  DELETE FROM public.event_agenda_item WHERE tenant_id=p_tenant AND event_id=p_event AND NOT(id=ANY(saved));
  SELECT to_jsonb(parent) INTO doc FROM public.event parent WHERE id=p_event AND tenant_id=p_tenant;
  RETURN doc||jsonb_build_object('_training_agenda_lines',(SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.sort_order,item.id),'[]')
    FROM public.event_agenda_item item WHERE item.event_id=p_event AND item.tenant_id=p_tenant));
END $$;
REVOKE ALL ON FUNCTION public.save_training_event_agenda(uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_training_event_agenda(uuid,uuid,jsonb,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

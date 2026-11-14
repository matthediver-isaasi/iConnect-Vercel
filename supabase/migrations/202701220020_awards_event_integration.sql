BEGIN;
CREATE FUNCTION public.awards_event_command(p_tenant uuid,p_actor_kind text,p_actor uuid,p_id uuid,p_expected_version bigint,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE link public.awards_event_link;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL THEN RAISE EXCEPTION 'Actor required'; END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.awards_event_link(tenant_id,award_id,programme_id,event_id,complex_event_id,
      show_information,show_application_link,audience,presentation_at)
      VALUES(p_tenant,(p_payload->>'award_id')::uuid,(p_payload->>'programme_id')::uuid,(p_payload->>'event_id')::uuid,
        (p_payload->>'complex_event_id')::uuid,coalesce((p_payload->>'show_information')::boolean,false),
        coalesce((p_payload->>'show_application_link')::boolean,false),coalesce(p_payload->>'audience','member'),
        (p_payload->>'presentation_at')::timestamptz) RETURNING * INTO link;
  ELSE
    SELECT * INTO link FROM public.awards_event_link WHERE tenant_id=p_tenant AND id=p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Event association unavailable' USING ERRCODE='P0002'; END IF;
    IF link.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Event association changed' USING ERRCODE='40001'; END IF;
    UPDATE public.awards_event_link SET
      show_information=coalesce((p_payload->>'show_information')::boolean,show_information),
      show_application_link=coalesce((p_payload->>'show_application_link')::boolean,show_application_link),
      audience=coalesce(p_payload->>'audience',audience),
      presentation_at=CASE WHEN p_payload ? 'presentation_at' THEN (p_payload->>'presentation_at')::timestamptz ELSE presentation_at END,
      version=version+1 WHERE id=link.id RETURNING * INTO link;
  END IF;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,changes)
    VALUES(p_tenant,link.award_id,p_actor_kind,p_actor,'event.associated',link.id,
      jsonb_build_object('version',link.version,'show_information',link.show_information,'show_application_link',link.show_application_link,'audience',link.audience));
  RETURN to_jsonb(link);
END $$;
CREATE FUNCTION public.awards_event_projection(p_tenant uuid,p_event uuid,p_complex boolean,p_audience text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE link public.awards_event_link; award public.awards_competition; results jsonb:='[]'; outcomes jsonb; shortlists jsonb; form_slug text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_audience NOT IN ('public','member') OR p_complex IS NULL THEN RAISE EXCEPTION 'Invalid event audience'; END IF;
  FOR link IN SELECT * FROM public.awards_event_link
    WHERE tenant_id=p_tenant AND CASE WHEN p_complex THEN complex_event_id=p_event ELSE event_id=p_event END
      AND (audience='public' OR p_audience='member') ORDER BY id LOOP
    FOR award IN SELECT a.* FROM public.awards_competition a WHERE a.tenant_id=p_tenant
      AND (a.id=link.award_id OR a.programme_id=link.programme_id) ORDER BY a.id LOOP
      outcomes:=public.awards_public_outcomes(p_tenant,award.id,'public',link.id);
      shortlists:=public.awards_public_shortlists(p_tenant,award.id,'public',link.id);
      IF p_audience='member' THEN
        outcomes:=outcomes||public.awards_public_outcomes(p_tenant,award.id,'member',link.id);
        shortlists:=shortlists||public.awards_public_shortlists(p_tenant,award.id,'member',link.id);
      END IF;
      form_slug:=NULL;
      IF link.show_application_link AND award.state='open' AND award.opens_at<=clock_timestamp() AND award.closes_at>clock_timestamp() THEN
        SELECT f.slug INTO form_slug FROM public.awards_form_binding b JOIN public.form f ON f.id=b.form_id
          WHERE b.tenant_id=p_tenant AND b.award_id=award.id AND b.active AND f.tenant_id=p_tenant AND f.is_active LIMIT 1;
      END IF;
      IF link.show_information OR form_slug IS NOT NULL OR jsonb_array_length(outcomes)>0 OR jsonb_array_length(shortlists)>0 THEN
        results:=results||jsonb_build_array(jsonb_build_object('awardId',award.id,'eventLinkId',link.id,
          'name',CASE WHEN link.show_information THEN award.name ELSE NULL END,
          'description',CASE WHEN link.show_information THEN award.description ELSE NULL END,
          'eligibility',CASE WHEN link.show_information THEN award.eligibility_information ELSE NULL END,
          'applicationSlug',form_slug,'outcomes',outcomes,'shortlists',shortlists));
      END IF;
    END LOOP;
  END LOOP;
  RETURN results;
END $$;
REVOKE ALL ON FUNCTION public.awards_event_command(uuid,text,uuid,uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_event_projection(uuid,uuid,boolean,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_event_command(uuid,text,uuid,uuid,bigint,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_event_projection(uuid,uuid,boolean,text) TO service_role;
COMMIT;

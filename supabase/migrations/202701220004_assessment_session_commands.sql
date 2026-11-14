BEGIN;
CREATE FUNCTION public.assessment_redeem_invitation(
  p_tenant uuid,p_token_hash text,p_session_hash text,p_csrf_hash text,p_accept boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE invitation public.assessment_invitation; appointment public.assessment_appointment;
  expiry timestamptz; competition uuid; session_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_accept IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$'
    OR p_session_hash IS NULL OR p_session_hash !~ '^[a-f0-9]{64}$'
    OR p_csrf_hash IS NULL OR p_csrf_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid invitation request'; END IF;
  SELECT * INTO invitation FROM public.assessment_invitation WHERE tenant_id=p_tenant AND token_hash=p_token_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='42501'; END IF;
  -- Appointment first in every session command: resend/revoke/redemption share
  -- the same lock order and generation fence.
  SELECT * INTO appointment FROM public.assessment_appointment
    WHERE tenant_id=p_tenant AND id=invitation.appointment_id FOR UPDATE;
  SELECT * INTO invitation FROM public.assessment_invitation
    WHERE id=invitation.id FOR UPDATE;
  IF appointment.id IS NULL OR appointment.member_id IS NOT NULL OR appointment.state NOT IN ('pending','invited')
    OR invitation.redeemed_at IS NOT NULL OR invitation.revoked_at IS NOT NULL OR invitation.expires_at<=clock_timestamp()
    OR invitation.generation<>appointment.credential_generation OR appointment.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='42501';
  END IF;
  SELECT r.award_id INTO competition FROM public.assessment_round r WHERE r.id=appointment.round_id AND r.tenant_id=p_tenant;
  UPDATE public.assessment_invitation SET redeemed_at=clock_timestamp() WHERE id=invitation.id;
  UPDATE public.assessment_appointment SET state=CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
    version=version+1 WHERE id=appointment.id;
  IF p_accept THEN
    expiry:=least(now()+interval '12 hours',coalesce(appointment.expires_at,'infinity'::timestamptz));
    INSERT INTO public.assessment_session(tenant_id,round_id,appointment_id,generation,token_hash,csrf_hash,expires_at)
      VALUES(p_tenant,appointment.round_id,appointment.id,appointment.credential_generation,p_session_hash,p_csrf_hash,expiry)
      RETURNING id INTO session_id;
  END IF;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id)
    VALUES(p_tenant,competition,'appointment',appointment.id,CASE WHEN p_accept THEN 'invitation.accepted' ELSE 'invitation.declined' END,invitation.id);
  RETURN jsonb_build_object('accepted',p_accept,'session_id',session_id,'expires_at',expiry,'appointment_id',appointment.id,'round_id',appointment.round_id);
END $$;

CREATE FUNCTION public.assessment_session_authority(p_tenant uuid,p_session_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.assessment_session; a public.assessment_appointment;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM public.assessment_session WHERE tenant_id=p_tenant AND token_hash=p_session_hash;
  IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Judging session unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO a FROM public.assessment_appointment WHERE tenant_id=p_tenant AND id=s.appointment_id;
  IF NOT FOUND OR a.state<>'accepted' OR a.member_id IS NOT NULL OR a.credential_generation<>s.generation
    OR a.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Judging session unavailable' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('session_id',s.id,'appointment_id',a.id,'round_id',a.round_id,
    'role',a.role,'csrf_hash',s.csrf_hash,'generation',s.generation,'expires_at',s.expires_at);
END $$;
-- Reads above are snapshots, not write authority: future scoring/download RPCs
-- must revalidate the same session/appointment under locks in their transaction.

CREATE FUNCTION public.assessment_rotate_invitation(
  p_tenant uuid,p_appointment uuid,p_expected_version bigint,p_actor_kind text,p_actor uuid,
  p_token_hash text,p_revoke boolean,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.assessment_appointment; competition uuid; expiry timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_revoke IS NULL OR p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0 THEN
    RAISE EXCEPTION 'Actor and reason required'; END IF;
  SELECT * INTO a FROM public.assessment_appointment WHERE tenant_id=p_tenant AND id=p_appointment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Appointment unavailable' USING ERRCODE='P0002'; END IF;
  IF a.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Appointment changed' USING ERRCODE='40001'; END IF;
  IF NOT p_revoke AND (a.member_id IS NOT NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'External invitation hash required'; END IF;
  IF NOT p_revoke AND a.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Renew appointment expiry before sending an invitation'; END IF;
  UPDATE public.assessment_invitation SET revoked_at=clock_timestamp() WHERE appointment_id=a.id AND revoked_at IS NULL;
  UPDATE public.assessment_session SET revoked_at=clock_timestamp() WHERE appointment_id=a.id AND revoked_at IS NULL;
  UPDATE public.assessment_appointment SET credential_generation=credential_generation+1,
    version=version+1,state=CASE WHEN p_revoke THEN 'revoked' ELSE 'invited' END WHERE id=a.id RETURNING * INTO a;
  IF NOT p_revoke THEN
    expiry:=least(now()+interval '7 days',coalesce(a.expires_at,'infinity'::timestamptz));
    INSERT INTO public.assessment_invitation(tenant_id,round_id,appointment_id,generation,token_hash,expires_at)
      VALUES(p_tenant,a.round_id,a.id,a.credential_generation,p_token_hash,expiry);
  END IF;
  SELECT r.award_id INTO competition FROM public.assessment_round r WHERE r.id=a.round_id AND r.tenant_id=p_tenant;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,competition,p_actor_kind,p_actor,CASE WHEN p_revoke THEN 'appointment.revoked' ELSE 'invitation.issued' END,
      a.id,p_reason,jsonb_build_object('generation',a.credential_generation));
  RETURN jsonb_build_object('appointment_id',a.id,'version',a.version,'expires_at',expiry,'state',a.state);
END $$;
REVOKE ALL ON FUNCTION public.assessment_redeem_invitation(uuid,text,text,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_session_authority(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_rotate_invitation(uuid,uuid,bigint,text,uuid,text,boolean,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_redeem_invitation(uuid,text,text,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.assessment_session_authority(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.assessment_rotate_invitation(uuid,uuid,bigint,text,uuid,text,boolean,text) TO service_role;
COMMIT;

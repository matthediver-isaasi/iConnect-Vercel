-- Admin-reviewed conversion only. Public checkout contact creation stays
-- separate and does not gain login access from this operation.
CREATE OR REPLACE FUNCTION public.create_member_from_event_registration(
  p_tenant_id uuid, p_booking_id uuid, p_complex boolean,
  p_first_name text, p_last_name text, p_email text,
  p_supplied_organization_name text, p_organization_id uuid, p_role_id uuid,
  p_role_effective_from date DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  booking_table text;
  event_table text;
  b jsonb;
  selected_role public.role%ROWTYPE;
  new_member_id uuid;
  normalized_email text := lower(btrim(p_email));
BEGIN
  IF p_tenant_id IS NULL OR p_booking_id IS NULL OR p_complex IS NULL
    OR coalesce(btrim(p_first_name), '') = '' OR coalesce(btrim(p_last_name), '') = ''
    OR coalesce(normalized_email, '') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR length(normalized_email) > 320 OR length(p_first_name) > 250
    OR length(p_last_name) > 250 OR length(p_supplied_organization_name) > 250
  THEN RAISE EXCEPTION 'Valid registration and member details are required.' USING ERRCODE='22023'; END IF;
  booking_table := CASE WHEN p_complex THEN 'complex_event_booking' ELSE 'booking' END;
  event_table := CASE WHEN p_complex THEN 'complex_event' ELSE 'event' END;
  -- Row lock serializes duplicate clicks and different-email concurrent submits.
  EXECUTE format('SELECT to_jsonb(b) FROM public.%I b WHERE b.id=$1 AND b.tenant_id=$2 FOR UPDATE', booking_table)
    INTO b USING p_booking_id, p_tenant_id;
  IF b IS NULL THEN RAISE EXCEPTION 'Registration not found.'; END IF;
  -- Tenant ownership is checked independently for the parent event.
  EXECUTE format('SELECT id FROM public.%I WHERE id=$1 AND tenant_id=$2 FOR SHARE', event_table)
    INTO new_member_id USING (b->>'event_id')::uuid, p_tenant_id;
  IF new_member_id IS NULL THEN RAISE EXCEPTION 'Event not found.'; END IF;
  IF b->>'member_id' IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.member m WHERE m.id=(b->>'member_id')::uuid AND m.tenant_id=p_tenant_id)
    THEN RAISE EXCEPTION 'Registration has an invalid member link. Review it before continuing.'; END IF;
    RETURN jsonb_build_object('member',jsonb_build_object('id',b->>'member_id'),'alreadyLinked',true);
  END IF;
  SELECT l.member_id INTO new_member_id
    FROM public.public_ticket_member_purchase p
    JOIN public.public_ticket_member_link l ON l.purchase_id=p.id
    JOIN public.member m ON m.id=l.member_id AND m.tenant_id=p.tenant_id
    WHERE p.tenant_id=p_tenant_id AND p.state='completed'
      AND p.event_kind=CASE WHEN p_complex THEN 'complex' ELSE 'simple' END
      AND p.event_id=(b->>'event_id')::uuid AND p_booking_id=ANY(p.booking_ids)
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(l.participation) x
        WHERE x->>'kind'='attendee' AND x->>'booking_id'=p_booking_id::text)
    LIMIT 1;
  IF new_member_id IS NOT NULL THEN
    RETURN jsonb_build_object('member',jsonb_build_object('id',new_member_id),'alreadyLinked',true);
  END IF;
  IF (p_complex AND b->>'organization_id' IS NOT NULL)
     OR (NOT p_complex AND coalesce((b->>'is_guest_booking')::boolean,false)=false AND b->>'organization_id' IS NOT NULL)
  THEN RAISE EXCEPTION 'This is not a guest registration.'; END IF;
  SELECT r.* INTO selected_role FROM public.role r
    WHERE r.id=p_role_id AND r.tenant_id=p_tenant_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose a role from this tenant.'; END IF;
  IF selected_role.requires_effective_from_date AND p_role_effective_from IS NULL
  THEN RAISE EXCEPTION 'An Effective From date is required for this role.'; END IF;
  IF selected_role.max_members IS NOT NULL AND p_organization_id IS NULL
  THEN RAISE EXCEPTION 'An organisation is required for a capacity-limited role.'; END IF;
  IF p_organization_id IS NOT NULL THEN
    PERFORM 1 FROM public.organization o WHERE o.id=p_organization_id AND o.tenant_id=p_tenant_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Choose an organisation from this tenant.'; END IF;
  END IF;
  -- Existing tenant/email uniqueness also arbitrates concurrent creates from
  -- other registrations, imports and public checkout. Never adopt an existing
  -- person's identity, change their role or activate their account implicitly.
  IF EXISTS (SELECT 1 FROM public.member m WHERE m.tenant_id=p_tenant_id AND lower(btrim(m.email))=normalized_email)
  THEN RAISE EXCEPTION 'A member with this email already exists. No new member was created.' USING ERRCODE='23505'; END IF;
  INSERT INTO public.member (
    tenant_id,first_name,last_name,email,supplied_organization_name,
    organization_id,role_id,role_effective_from,login_enabled,status,
    show_in_directory,is_guest,communications_opted_out_all
  ) VALUES (
    p_tenant_id,btrim(p_first_name),btrim(p_last_name),normalized_email,nullif(btrim(p_supplied_organization_name),''),
    p_organization_id,p_role_id,p_role_effective_from,true,'active',
    false,false,true
  ) RETURNING id INTO new_member_id;
  -- Preserve historical registrant details, guest provenance, payer identity,
  -- organisation, ticket and every financial field. Link only this attendee.
  EXECUTE format('UPDATE public.%I SET member_id=$1 WHERE id=$2 AND tenant_id=$3', booking_table)
    USING new_member_id,p_booking_id,p_tenant_id;
  RETURN jsonb_build_object('member',jsonb_build_object('id',new_member_id),'alreadyLinked',false);
END;
$$;
REVOKE ALL ON FUNCTION public.create_member_from_event_registration(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_member_from_event_registration(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date) TO service_role;

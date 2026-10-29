BEGIN;
CREATE FUNCTION public.create_public_invoice_booker(
 p_tenant_id uuid,p_booking_id uuid,p_complex boolean,p_first_name text,p_last_name text,p_email text,
 p_supplied_organization_name text,p_organization_id uuid,p_role_id uuid,
 p_role_effective_from date DEFAULT NULL,p_organization_group_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b jsonb; tbl text; selected_role public.role; new_member_id uuid; normalized_email text:=lower(trim(p_email));
BEGIN
 IF p_tenant_id IS NULL OR p_booking_id IS NULL OR p_complex IS NULL OR p_role_id IS NULL
   OR coalesce(trim(p_first_name),'')='' OR coalesce(trim(p_last_name),'')=''
   OR coalesce(normalized_email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
   OR length(normalized_email)>320 OR length(p_first_name)>250 OR length(p_last_name)>250
   OR length(p_supplied_organization_name)>250 THEN RAISE EXCEPTION 'Valid booker details are required'; END IF;
 tbl:=CASE WHEN p_complex THEN 'complex_event_booking' ELSE 'booking' END;
 EXECUTE format('SELECT to_jsonb(b) FROM public.%I b WHERE id=$1 AND tenant_id=$2 FOR UPDATE',tbl)
 INTO b USING p_booking_id,p_tenant_id;
 IF b IS NULL OR b->>'payment_method' IS DISTINCT FROM 'public_invoice_po'
   OR b#>>'{purchaser_context,classification}' IS DISTINCT FROM 'public_non_member'
   OR lower(trim(b#>>'{purchaser_context,details,email}')) IS DISTINCT FROM normalized_email
 THEN RAISE EXCEPTION 'The member email must match the original public Invoice / PO booker'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':public-booker:'||normalized_email,0));
 IF EXISTS(SELECT 1 FROM member WHERE tenant_id=p_tenant_id AND lower(trim(email))=normalized_email)
 THEN RAISE EXCEPTION 'A member with this email already exists. Refresh the invoice panel.' USING ERRCODE='23505'; END IF;
 -- If the original booker is also this attendee, reuse the existing atomic
 -- account-and-registration-link operation without changing its behaviour.
 IF lower(trim(b->>'attendee_email'))=normalized_email AND nullif(b->>'member_id','') IS NULL THEN
   RETURN public.create_member_from_event_registration(p_tenant_id,p_booking_id,p_complex,
     p_first_name,p_last_name,p_email,p_supplied_organization_name,p_organization_id,p_role_id,
     p_role_effective_from,p_organization_group_id);
 END IF;
 IF p_organization_id IS NOT NULL AND p_organization_group_id IS NOT NULL THEN RAISE EXCEPTION 'Select an organisation or group, not both'; END IF;
 SELECT * INTO selected_role FROM role WHERE id=p_role_id AND tenant_id=p_tenant_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Choose a valid role'; END IF;
 IF selected_role.requires_effective_from_date AND p_role_effective_from IS NULL THEN RAISE EXCEPTION 'Role effective date is required'; END IF;
 IF selected_role.max_members IS NOT NULL AND p_organization_id IS NULL THEN RAISE EXCEPTION 'An organisation is required for this role'; END IF;
 IF p_organization_id IS NOT NULL THEN
   PERFORM 1 FROM organization WHERE id=p_organization_id AND tenant_id=p_tenant_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Invalid organisation'; END IF;
 END IF;
 IF p_organization_group_id IS NOT NULL THEN
   PERFORM 1 FROM organization_group WHERE id=p_organization_group_id AND tenant_id=p_tenant_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Invalid organisation group'; END IF;
 END IF;
 INSERT INTO member(tenant_id,first_name,last_name,email,supplied_organization_name,organization_id,organization_group_id,
   role_id,role_effective_from,login_enabled,status,show_in_directory,is_guest,communications_opted_out_all)
 VALUES(p_tenant_id,trim(p_first_name),trim(p_last_name),normalized_email,nullif(trim(p_supplied_organization_name),''),
   p_organization_id,p_organization_group_id,p_role_id,
   CASE WHEN selected_role.requires_effective_from_date THEN p_role_effective_from END,true,'active',false,false,true)
 RETURNING id INTO new_member_id;
 RETURN jsonb_build_object('member',jsonb_build_object('id',new_member_id),'alreadyLinked',false);
END $$;
REVOKE ALL ON FUNCTION public.create_public_invoice_booker(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_invoice_booker(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

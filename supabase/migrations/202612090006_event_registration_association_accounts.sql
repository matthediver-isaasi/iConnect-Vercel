BEGIN;
-- The existing purchase snapshot is immutable and server-owned. Selection
-- snapshots add account association authority, never paid membership authority.
CREATE FUNCTION public.assert_registration_account_association(p_tenant uuid,p_association jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ok boolean;
BEGIN
 IF p_association IS NULL THEN RETURN false; END IF;
 IF p_association->>'kind' NOT IN ('organization','group') OR nullif(p_association->>'id','') IS NULL
 THEN RAISE EXCEPTION 'Invalid registration association'; END IF;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id=$1 AND tenant_id=$2)',
   CASE p_association->>'kind' WHEN 'organization' THEN 'organization' ELSE 'organization_group' END)
 INTO ok USING (p_association->>'id')::uuid,p_tenant;
 IF NOT ok THEN RAISE EXCEPTION 'Registration association no longer exists'; END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.assert_registration_account_association(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.assert_registration_account_association(uuid,jsonb) TO service_role;

DO $patch$
DECLARE d text; old text; replacement text;
BEGIN
 d:=pg_get_functiondef('public.provision_public_ticket_members(uuid)'::regprocedure);
 old:=$old$OR coalesce(purchase.completion_evidence->>'status', '') NOT IN ('paid', 'free')$old$;
 replacement:=$new$OR (coalesce(purchase.completion_evidence->>'status', '') NOT IN ('paid', 'free')
   AND NOT (purchase.completion_evidence->>'status'='unpaid' AND purchase.snapshot->>'association_role_id' IS NOT NULL))$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Provisioning evidence contract changed'; END IF;
 d:=replace(d,old,replacement);
 old:=$old$($4=''free'' AND b.payment_method=''free'' AND $5 IS NULL)$old$;
 replacement:=$new$(($4=''free'' AND b.payment_method=''free'' AND $5 IS NULL)
   OR ($4=''unpaid'' AND b.payment_method=''public_invoice_po'' AND $5 IS NULL AND b.stripe_payment_intent_id IS NULL))$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Provisioning booking evidence contract changed'; END IF;
 d:=replace(d,old,replacement);
 old:=$old$organization_id, role_id, login_enabled, show_in_directory$old$;
 replacement:=$new$organization_id, role_id, login_enabled, show_in_directory, organization_group_id$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Provisioning member columns changed'; END IF;
 d:=replace(d,old,replacement);
 old:=$old$person->'identity'->>'organization', NULL, selected_role.id, false, false$old$;
 replacement:=$new$person->'identity'->>'organization',
 CASE WHEN person#>>'{association,kind}'='organization' THEN (person#>>'{association,id}')::uuid END,
 selected_role.id,public.assert_registration_account_association(purchase.tenant_id,person->'association'),false,
 CASE WHEN person#>>'{association,kind}'='group' THEN (person#>>'{association,id}')::uuid END$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Provisioning member values changed'; END IF;
 d:=replace(d,old,replacement);
 EXECUTE d;

 d:=pg_get_functiondef('public.insert_public_ticket_booking_batch(uuid,jsonb)'::regprocedure);
 old:=$old$WHEN 'simple' THEN public.check_oneoff_ticket_capacity(purchase.event_id,ticket.id,ticket.quantity,NULL)$old$;
 replacement:=$new$WHEN 'simple' THEN CASE
   WHEN ticket.id IS NULL AND EXISTS(SELECT 1 FROM public.event e
     WHERE e.id=purchase.event_id AND e.tenant_id=purchase.tenant_id
     AND coalesce(e.pricing_config->'ticket_classes','[]'::jsonb)='[]'::jsonb)
   THEN '{"ok":true}'::jsonb
   ELSE public.check_oneoff_ticket_capacity(purchase.event_id,ticket.id,ticket.quantity,NULL) END$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Booking capacity contract changed'; END IF;
 d:=replace(d,old,replacement);
 old:=$old$OR coalesce(row_data->>'payment_method','') NOT IN ('card','free')$old$;
 replacement:=$new$OR (coalesce(row_data->>'payment_method','') NOT IN ('card','free')
 AND NOT (row_data->>'payment_method'='public_invoice_po' AND purchase.snapshot->>'association_role_id' IS NOT NULL
   AND purchase.stripe_payment_intent_id IS NULL AND nullif(row_data->>'stripe_payment_intent_id','') IS NULL))$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Booking batch payment contract changed'; END IF;
 d:=replace(d,old,replacement);
 old:=$old$row_data->>'ticket_class_id' IS DISTINCT FROM expected->row_index->>'ticket_id'$old$;
 replacement:=$new$coalesce(row_data->>'ticket_class_id','default') IS DISTINCT FROM expected->row_index->>'ticket_id'$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Booking batch ticket contract changed'; END IF;
 EXECUTE replace(d,old,replacement);
END $patch$;
NOTIFY pgrst,'reload schema';
COMMIT;

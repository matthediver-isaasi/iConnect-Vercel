BEGIN;
-- Keep older UI/API instances from creating a second member after a correction.
DO $patch$
DECLARE d text; old text; replacement text;
BEGIN
 d:=pg_get_functiondef('public.create_public_invoice_booker(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date,uuid)'::regprocedure);
 old:='DECLARE b jsonb; tbl text;';
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Booker creation declaration changed'; END IF;
 d:=replace(d,old,'DECLARE b jsonb; correction_group text; tbl text;');
 old:=$old$ EXECUTE format('SELECT to_jsonb(b) FROM public.%I b WHERE id=$1 AND tenant_id=$2 FOR UPDATE',tbl)
 INTO b USING p_booking_id,p_tenant_id;$old$;
 replacement:=$new$ EXECUTE format('SELECT booking_group_reference FROM public.%I WHERE id=$1 AND tenant_id=$2',tbl)
 INTO correction_group USING p_booking_id,p_tenant_id;
 IF nullif(correction_group,'') IS NULL THEN RAISE EXCEPTION 'Booking group unavailable'; END IF;
 -- Same order as correction/approval: group advisory lock, then booking row.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':public-po:'||tbl||':'||correction_group,0));
 EXECUTE format('SELECT to_jsonb(b) FROM public.%I b WHERE id=$1 AND tenant_id=$2 FOR UPDATE',tbl)
 INTO b USING p_booking_id,p_tenant_id;
 IF b->>'booking_group_reference' IS DISTINCT FROM correction_group THEN RAISE EXCEPTION 'Booking group changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.public_po_booker_correction
   WHERE tenant_id=p_tenant_id AND source=tbl AND booking_group_reference=correction_group)
 THEN RAISE EXCEPTION 'An approved booker correction already links an existing member. Refresh the invoice panel; do not create another account.'; END IF;$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Booker creation locking contract changed'; END IF;
 EXECUTE replace(d,old,replacement);
END $patch$;
NOTIFY pgrst,'reload schema';
COMMIT;

BEGIN;
-- Append-only, service-owned corrections. Historical booking identity is never edited.
CREATE TABLE public.public_po_booker_correction (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 source text NOT NULL CHECK (source IN ('booking','complex_event_booking')),
 booking_group_reference text NOT NULL,
 event_id uuid NOT NULL,
 member_id uuid NOT NULL,
 original_context jsonb NOT NULL,
 corrected_details jsonb NOT NULL,
 actor_id text NOT NULL CHECK (length(trim(actor_id)) > 0),
 reason text NOT NULL CHECK (length(trim(reason)) > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,source,booking_group_reference)
);
ALTER TABLE public.public_po_booker_correction ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.public_po_booker_correction FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.public_po_booker_correction TO service_role;

CREATE FUNCTION public.correct_public_po_booker(
 p_tenant uuid,p_source text,p_group text,p_member uuid,p_email text,
 p_actor text,p_reason text,p_expected jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE records jsonb; b jsonb; m member; c public_po_booker_correction;
BEGIN
 IF p_tenant IS NULL OR p_source IS NULL OR p_source NOT IN ('booking','complex_event_booking')
 OR nullif(trim(p_group),'') IS NULL OR p_member IS NULL OR nullif(trim(p_actor),'') IS NULL
 OR nullif(trim(p_reason),'') IS NULL OR p_expected IS NULL
 OR jsonb_typeof(p_expected) IS DISTINCT FROM 'array' OR jsonb_array_length(p_expected)=0
 OR p_email IS NULL OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
 THEN RAISE EXCEPTION 'Invalid booker correction'; END IF;
 -- Same lock as invoice approval: correction and approval cannot pass each other.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':public-po:'||p_source||':'||p_group,0));
 IF EXISTS(SELECT 1 FROM public_invoice_po_billing WHERE tenant_id=p_tenant AND source=p_source AND booking_group_reference=p_group)
 THEN RAISE EXCEPTION 'An invoice approval already exists; correction requires separate review'; END IF;
 EXECUTE format('SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM
 (SELECT * FROM public.%I WHERE tenant_id=$1 AND booking_group_reference=$2 ORDER BY id FOR UPDATE) b',p_source)
 INTO records USING p_tenant,p_group;
 IF records IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Booking changed; review correction again'; END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(records) LOOP
  IF b->>'payment_method' IS DISTINCT FROM 'public_invoice_po' OR b->>'status' IS DISTINCT FROM 'confirmed'
   OR b#>>'{purchaser_context,classification}' IS DISTINCT FROM 'public_non_member'
   OR b->'purchaser_context' IS DISTINCT FROM records#>'{0,purchaser_context}'
   OR b->>'event_id' IS DISTINCT FROM records#>>'{0,event_id}'
   OR nullif(b->>'public_invoice_po_billing_id','') IS NOT NULL
   OR nullif(b->>'xero_invoice_id','') IS NOT NULL OR nullif(b->>'accounting_invoice_id','') IS NOT NULL
   OR nullif(b->>'stripe_payment_intent_id','') IS NOT NULL
  THEN RAISE EXCEPTION 'Only an uninvoiced consistent public PO booking may be corrected'; END IF;
 END LOOP;
 SELECT * INTO m FROM member WHERE tenant_id=p_tenant AND id=p_member FOR SHARE;
 IF NOT FOUND OR lower(trim(m.email)) IS DISTINCT FROM lower(trim(p_email))
 THEN RAISE EXCEPTION 'Corrected member identity changed'; END IF;
 IF (SELECT count(*) FROM member WHERE tenant_id=p_tenant AND lower(trim(email))=lower(trim(p_email)))<>1
 THEN RAISE EXCEPTION 'Corrected email is ambiguous'; END IF;
 SELECT * INTO c FROM public_po_booker_correction WHERE tenant_id=p_tenant AND source=p_source AND booking_group_reference=p_group;
 IF FOUND THEN
  IF c.member_id=p_member AND c.corrected_details->>'email'=lower(trim(p_email))
   AND c.original_context=records#>'{0,purchaser_context}' THEN RETURN c.id; END IF;
  RAISE EXCEPTION 'A different correction already exists';
 END IF;
 INSERT INTO public_po_booker_correction(tenant_id,source,booking_group_reference,event_id,member_id,
 original_context,corrected_details,actor_id,reason)
 VALUES(p_tenant,p_source,p_group,(records#>>'{0,event_id}')::uuid,p_member,records#>'{0,purchaser_context}',
 (records#>'{0,purchaser_context,details}') || jsonb_build_object('email',lower(trim(p_email)),
 'first_name',m.first_name,'last_name',m.last_name),p_actor,p_reason) RETURNING id INTO c.id;
 RETURN c.id;
END $$;
REVOKE ALL ON FUNCTION public.correct_public_po_booker(uuid,text,text,uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.correct_public_po_booker(uuid,text,text,uuid,text,text,text,jsonb) TO service_role;

ALTER TABLE public.public_invoice_po_billing
 ADD COLUMN booker_correction_id uuid REFERENCES public.public_po_booker_correction(id),
 ADD COLUMN billing_contact jsonb,
 ADD COLUMN email_delivery_recipient text;
GRANT UPDATE(email_delivery_recipient) ON public.public_invoice_po_billing TO service_role;
-- During a mixed-version rollout an old mail worker must not claim a corrected
-- invoice and send it to original_records. A new worker explicitly acknowledges
-- the frozen recipient in its atomic claim; retries clear that acknowledgement.
CREATE FUNCTION public.guard_public_po_corrected_delivery()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.booker_correction_id IS NOT NULL THEN
  IF NEW.email_status='pending' THEN NEW.email_delivery_recipient:=NULL;
  ELSIF NEW.email_status IN ('preparing','sending') AND
   (nullif(NEW.billing_contact->>'email','') IS NULL
    OR NEW.email_delivery_recipient IS DISTINCT FROM NEW.billing_contact->>'email')
  THEN RAISE EXCEPTION 'Corrected invoice delivery requires a recipient-aware worker'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_public_po_corrected_delivery() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER public_po_corrected_delivery_guard BEFORE INSERT OR UPDATE
 ON public.public_invoice_po_billing FOR EACH ROW EXECUTE FUNCTION public.guard_public_po_corrected_delivery();
-- No column update grants: the approved contact is frozen for delivery/retries.
DO $patch$
DECLARE d text; old text; replacement text;
BEGIN
 d:=pg_get_functiondef('public.public_invoice_po_bill(uuid,text,text,uuid,text,jsonb,numeric,text,text,jsonb)'::regprocedure);
 old:='DECLARE rows_now jsonb; r public_invoice_po_billing; b jsonb; purchaser_email text; result jsonb;';
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Approval declaration contract changed'; END IF;
 d:=replace(d,old,old||' c public_po_booker_correction; effective_details jsonb;');
 old:=$old$ purchaser_email:=lower(trim(rows_now#>>'{0,purchaser_context,details,email}'));$old$;
 replacement:=$new$ SELECT * INTO c FROM public_po_booker_correction
 WHERE tenant_id=p_tenant AND source=p_source AND booking_group_reference=p_group;
 effective_details:=rows_now#>'{0,purchaser_context,details}';
 IF c.id IS NOT NULL THEN
  IF c.member_id IS DISTINCT FROM p_member OR c.event_id::text IS DISTINCT FROM rows_now#>>'{0,event_id}'
   OR c.original_context IS DISTINCT FROM rows_now#>'{0,purchaser_context}'
  THEN RAISE EXCEPTION 'Booker correction no longer matches'; END IF;
  effective_details:=c.corrected_details;
 END IF;
 IF nullif(p_snapshot->>'publicPoBookerCorrectionId','') IS DISTINCT FROM c.id::text
 THEN RAISE EXCEPTION 'Booker correction changed; review invoice again'; END IF;
 purchaser_email:=lower(trim(effective_details->>'email'));
 IF lower(trim(CASE WHEN p_provider='xero' THEN p_snapshot#>>'{contact,email}'
   ELSE p_snapshot#>>'{invoice,contact,email}' END)) IS DISTINCT FROM purchaser_email
 THEN RAISE EXCEPTION 'Invoice contact does not match approved booker'; END IF;
$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Approval identity contract changed'; END IF;
 d:=replace(d,old,replacement);
 old:='original_records,amount,currency,provider,provider_snapshot,amount_due)';
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Approval insert contract changed'; END IF;
 d:=replace(d,old,'original_records,amount,currency,provider,provider_snapshot,amount_due,booker_correction_id,billing_contact)');
 old:='rows_now,p_amount,p_currency,p_provider,p_snapshot,p_amount) RETURNING * INTO r;';
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Approval values contract changed'; END IF;
 d:=replace(d,old,'rows_now,p_amount,p_currency,p_provider,p_snapshot,p_amount,c.id,effective_details) RETURNING * INTO r;');
 EXECUTE d;
END $patch$;
NOTIFY pgrst,'reload schema';
COMMIT;

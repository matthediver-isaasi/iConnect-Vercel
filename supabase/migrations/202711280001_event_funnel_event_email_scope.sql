-- event_email has no tenant_id column: templates belong to their event, and
-- events belong to one tenant. Three funnel delivery functions filtered
-- event_email by a non-existent tenant_id, so every confirmed funnel order's
-- reminder planning and confirmation emails failed at run time and retried
-- forever. Scope templates by the original tenant-owned registration's event
-- (and its simple/complex model) instead. No other behaviour changes.
BEGIN;
DO $$
DECLARE def text;needle text;
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_integration_operation(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure) INTO def;
 needle:='FROM public.event_email t WHERE t.tenant_id=p_tenant';
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected integration template baseline';END IF;
 def:=replace(def,needle,'FROM public.event_email t WHERE coalesce(t.is_complex_event,false)=(item.booking_source=''complex_event_booking'')');
 EXECUTE def;

 SELECT pg_get_functiondef('public.event_funnel_confirmation_operation(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure) INTO def;
 needle:='FROM public.event_email e WHERE e.tenant_id=p_tenant AND e.event_id=b.event_id';
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected confirmation template baseline';END IF;
 def:=replace(def,needle,'FROM public.event_email e WHERE e.event_id=b.event_id'
   ||' AND coalesce(e.is_complex_event,false)=(b.booking_source=''complex_event_booking'')');
 EXECUTE def;

 SELECT pg_get_functiondef('public.event_funnel_suppress_cancelled_delivery(uuid,uuid)'::regprocedure) INTO def;
 needle:='WHERE scheduled.event_email_id=template.id AND template.tenant_id=p_tenant';
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected suppression template baseline';END IF;
 -- The existing event_id and simple/complex model conditions remain.
 def:=replace(def,needle,'WHERE scheduled.event_email_id=template.id');
 EXECUTE def;
END $$;
-- CREATE OR REPLACE keeps each function's existing grants unchanged.
COMMIT;

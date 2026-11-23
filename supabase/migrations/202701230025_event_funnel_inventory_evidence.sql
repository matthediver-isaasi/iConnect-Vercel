BEGIN;
-- Cancellation must undo the counter movement actually committed, not infer it
-- from a later event configuration. Historical orders are deliberately not guessed.
CREATE TABLE public.event_funnel_inventory_evidence (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,event_kind text NOT NULL CHECK(event_kind IN ('simple','complex')),
 event_id uuid NOT NULL,places bigint NOT NULL CHECK(places>0),
 legacy_debit_places bigint NOT NULL CHECK(legacy_debit_places>=0 AND legacy_debit_places<=places),
 restored_places bigint NOT NULL DEFAULT 0 CHECK(restored_places>=0 AND restored_places<=legacy_debit_places),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,order_id,event_kind,event_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
ALTER TABLE public.event_funnel_inventory_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_inventory_evidence FROM PUBLIC,anon,authenticated,service_role;
DO $$
DECLARE def text;needle text:=$old$    IF public.event_funnel_counter_is_finite(ev.event_kind,event_data) THEN$old$;
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_finalize_order(uuid,uuid,jsonb)'::regprocedure) INTO def;
 IF position(needle IN def)=0 OR position(needle IN substring(def FROM position(needle IN def)+length(needle)))>0
 THEN RAISE EXCEPTION 'Unexpected funnel inventory finalization baseline';END IF;
 EXECUTE replace(def,needle,$new$    INSERT INTO public.event_funnel_inventory_evidence(
      tenant_id,order_id,event_kind,event_id,places,legacy_debit_places)
      VALUES(p_tenant,p_order,ev.event_kind,ev.event_id,ev.places,
        CASE WHEN public.event_funnel_counter_is_finite(ev.event_kind,event_data) THEN ev.places ELSE 0 END);
$new$||needle);
END $$;
COMMIT;

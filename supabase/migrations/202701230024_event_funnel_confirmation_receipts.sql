BEGIN;
ALTER TABLE public.event_funnel_confirmation
 ADD COLUMN receipt_token uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN provider_delivery_state text CHECK(provider_delivery_state IN ('accepted','delivered','failed')),
 ADD COLUMN provider_event_at timestamptz;
CREATE FUNCTION public.event_funnel_confirmation_receipt(
 p_item uuid,p_nonce uuid,p_recipient text,p_message_id text,p_event text,p_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.event_funnel_confirmation;
BEGIN
 SELECT * INTO c FROM public.event_funnel_confirmation WHERE id=p_item AND receipt_token=p_nonce;
 IF NOT FOUND THEN RETURN false;END IF;
 PERFORM 1 FROM public.event_funnel_delivery WHERE tenant_id=c.tenant_id AND order_id=c.order_id AND kind='confirmations' FOR UPDATE;
 SELECT * INTO c FROM public.event_funnel_confirmation WHERE id=p_item AND receipt_token=p_nonce FOR UPDATE;
 IF NOT FOUND OR p_at IS NULL OR p_event NOT IN ('accepted','delivered','failed') OR p_event IS NULL
   OR nullif(p_message_id,'') IS NULL OR length(p_message_id)>500 THEN RETURN false;END IF;
 IF c.state='delivered' AND c.redacted_at IS NOT NULL THEN RETURN true;END IF;
 IF c.payload IS NULL OR c.attempt_token IS NULL
   OR lower(trim(c.payload->>'to')) IS DISTINCT FROM lower(trim(p_recipient))
   OR c.message_id IS NOT NULL AND regexp_replace(c.message_id,'^<|>$','','g')<>p_message_id THEN RETURN false;END IF;
 IF c.provider_event_at>p_at OR (c.provider_event_at=p_at AND
   CASE c.provider_delivery_state WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2 ELSE 1 END >=
   CASE p_event WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2 ELSE 1 END) THEN RETURN true;END IF;
 UPDATE public.event_funnel_confirmation SET message_id=p_message_id,provider_delivery_state=p_event,provider_event_at=p_at,
   state=CASE p_event WHEN 'failed' THEN 'needs_review' ELSE 'delivered' END,
   delivered_at=CASE p_event WHEN 'failed' THEN delivered_at ELSE coalesce(delivered_at,clock_timestamp()) END
 WHERE id=c.id;
 -- Wake the outbox without stealing a live worker's lease. No new email is
 -- authorized: the per-message journal remains the only sending authority.
 UPDATE public.event_funnel_delivery SET state='pending',next_attempt_at=clock_timestamp()
 WHERE tenant_id=c.tenant_id AND order_id=c.order_id AND kind='confirmations' AND state<>'running';
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_confirmation_receipt(uuid,uuid,text,text,text,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_confirmation_receipt(uuid,uuid,text,text,text,timestamptz) TO service_role;
-- Receipt delivery may beat the synchronous sender response. An already
-- delivered item must be an idempotent finish, never an excuse to send again.
DO $$
DECLARE def text;needle text:=$old$ELSIF p_action='finish' THEN$old$;
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_confirmation_operation(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure) INTO def;
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected confirmation operation baseline';END IF;
 EXECUTE replace(def,needle,needle||$new$
    IF c.state='delivered' THEN RETURN jsonb_build_object('saved',true); END IF;
$new$);
END $$;
COMMIT;

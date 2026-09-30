-- Task #3881: immutable quote delivery links and customer decision audit.
CREATE TABLE public.sales_quote_delivery_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  recipient_email text,
  expires_at timestamptz NOT NULL,
  activated_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,quote_id) REFERENCES public.sales_quote(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,quote_version_id) REFERENCES public.sales_quote_version(tenant_id,id) ON DELETE CASCADE,
  CHECK (octet_length(token_hash)=32 AND expires_at>created_at AND (activated_at IS NULL OR activated_at>=created_at))
);
CREATE INDEX sales_quote_delivery_version ON public.sales_quote_delivery_token(tenant_id,quote_version_id,created_at DESC);

CREATE TABLE public.sales_quote_delivery_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  token_id uuid,
  event_type text NOT NULL,
  recipient_email text,
  actor_id text,
  sender_domain text,
  provider_message_id text,
  error_message text,
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,quote_id) REFERENCES public.sales_quote(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,quote_version_id) REFERENCES public.sales_quote_version(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,token_id) REFERENCES public.sales_quote_delivery_token(tenant_id,id) ON DELETE RESTRICT,
  CHECK (event_type IN ('send_attempt','sent','send_failed','send_transition_failed','viewed','downloaded','revoked','expired','accepted','declined')),
  CHECK (jsonb_typeof(request_metadata)='object')
);
CREATE INDEX sales_quote_delivery_audit_history ON public.sales_quote_delivery_audit(tenant_id,quote_id,created_at DESC);
CREATE UNIQUE INDEX sales_quote_delivery_expired_once
 ON public.sales_quote_delivery_audit(token_id,event_type)
 WHERE event_type='expired';

CREATE TABLE public.sales_quote_customer_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  token_id uuid NOT NULL,
  decision text NOT NULL,
  customer_name text NOT NULL,
  customer_role text,
  purchase_order_reference text,
  customer_reference text,
  decline_reason text,
  agreement boolean NOT NULL DEFAULT false,
  idempotency_key text NOT NULL,
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,quote_version_id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,quote_id) REFERENCES public.sales_quote(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,quote_version_id) REFERENCES public.sales_quote_version(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,token_id) REFERENCES public.sales_quote_delivery_token(tenant_id,id) ON DELETE RESTRICT,
  CHECK (decision IN ('accepted','declined') AND length(btrim(customer_name)) BETWEEN 1 AND 200),
  CHECK ((decision='accepted' AND agreement) OR (decision='declined' AND NOT agreement)),
  CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  CHECK (jsonb_typeof(request_metadata)='object')
);

CREATE OR REPLACE FUNCTION public.guard_sales_quote_delivery_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN RAISE EXCEPTION 'Quote delivery audit is append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER sales_quote_delivery_audit_immutable BEFORE UPDATE OR DELETE ON public.sales_quote_delivery_audit
 FOR EACH ROW EXECUTE FUNCTION public.guard_sales_quote_delivery_append_only();
CREATE TRIGGER sales_quote_decision_immutable BEFORE UPDATE OR DELETE ON public.sales_quote_customer_decision
 FOR EACH ROW EXECUTE FUNCTION public.guard_sales_quote_delivery_append_only();

-- Public customers are a distinct principal, not fabricated tenant members.
ALTER TABLE public.sales_commercial_sale DROP CONSTRAINT IF EXISTS sales_commercial_sale_confirmed_by_kind_check;
ALTER TABLE public.sales_commercial_sale ADD CONSTRAINT sales_commercial_sale_confirmed_by_kind_check
 CHECK (confirmed_by_kind IN ('tenant_user','member','customer'));
ALTER TABLE public.sales_commercial_allocation_movement DROP CONSTRAINT IF EXISTS sales_commercial_allocation_movement_actor_kind_check;
ALTER TABLE public.sales_commercial_allocation_movement ADD CONSTRAINT sales_commercial_allocation_movement_actor_kind_check
 CHECK (actor_kind IN ('tenant_user','member','system','customer'));
ALTER TABLE public.opportunity_stage_history DROP CONSTRAINT IF EXISTS opportunity_stage_history_actor_kind_check;
ALTER TABLE public.opportunity_stage_history ADD CONSTRAINT opportunity_stage_history_actor_kind_check
 CHECK (actor_kind IN ('tenant_user','member','customer'));
ALTER TABLE public.opportunity_activity DROP CONSTRAINT IF EXISTS opportunity_activity_actor_kind_check;
ALTER TABLE public.opportunity_activity ADD CONSTRAINT opportunity_activity_actor_kind_check
 CHECK (actor_kind IN ('tenant_user','member','system','customer'));
ALTER TABLE public.sales_quote_status_history DROP CONSTRAINT IF EXISTS sales_quote_status_history_actor_type_check;
ALTER TABLE public.sales_quote_status_history ADD CONSTRAINT sales_quote_status_history_actor_type_check
 CHECK (actor_type IN ('tenant_user','member','system','customer'));

-- Preserve the ticket allocation implementation and put a general sale
-- boundary in front of it. The previous function rejected valid service-only
-- quotes because it required at least one event-bearing line.
ALTER FUNCTION public.confirm_sales_quote_sale(uuid,uuid,integer,text,text,uuid)
 RENAME TO confirm_sales_quote_ticket_sale;
-- The preserved ticket implementation previously admitted only authenticated
-- principals. Extend that validation narrowly for the new customer principal.
DO $migration$
DECLARE definition text; updated text;
BEGIN
 SELECT pg_get_functiondef('public.confirm_sales_quote_ticket_sale(uuid,uuid,integer,text,text,uuid)'::regprocedure)
  INTO definition;
 updated:=replace(definition,
   'p_actor_kind NOT IN (''tenant_user'',''member'')',
   'p_actor_kind NOT IN (''tenant_user'',''member'',''customer'')');
 IF updated=definition THEN RAISE EXCEPTION 'could not update ticket sale customer actor validation'; END IF;
 EXECUTE updated;
END $migration$;
CREATE OR REPLACE FUNCTION public.confirm_sales_quote_sale(
 p_tenant_id uuid,p_quote_id uuid,p_expected_version integer,p_idempotency_key text,
 p_actor_kind text,p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.sales_quote%ROWTYPE; v public.sales_quote_version%ROWTYPE;
DECLARE s public.sales_commercial_sale%ROWTYPE; won public.opportunity_stage%ROWTYPE;
DECLARE has_tickets boolean;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public.sales_commercial_sale
  WHERE tenant_id=p_tenant_id AND idempotency_key=p_idempotency_key;
 IF FOUND THEN
   IF s.quote_id<>p_quote_id THEN RAISE EXCEPTION 'idempotency key belongs to another quote' USING ERRCODE='23505'; END IF;
   RETURN jsonb_build_object('saleId',s.id,'idempotent',true);
 END IF;
 SELECT * INTO q FROM public.sales_quote WHERE tenant_id=p_tenant_id AND id=p_quote_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'quote not found' USING ERRCODE='P0002'; END IF;
 IF q.row_version<>p_expected_version THEN RAISE EXCEPTION 'quote version conflict' USING ERRCODE='40001'; END IF;
 SELECT * INTO v FROM public.sales_quote_version WHERE tenant_id=p_tenant_id
  AND quote_id=q.id AND version_number=q.current_version FOR UPDATE;
 IF v.status<>'accepted' THEN RAISE EXCEPTION 'only an accepted quote can become a sale' USING ERRCODE='23514'; END IF;
 SELECT EXISTS(
   SELECT 1 FROM public.sales_quote_line l LEFT JOIN public.sales_catalogue_product p
    ON p.tenant_id=l.tenant_id AND p.id=l.product_id
   LEFT JOIN public.sales_quote_bundle_component c ON c.tenant_id=l.tenant_id AND c.quote_line_id=l.id
   LEFT JOIN public.sales_catalogue_product cp ON cp.tenant_id=c.tenant_id AND cp.id=c.product_id
   WHERE l.tenant_id=p_tenant_id AND l.quote_version_id=v.id
     AND (p.event_id IS NOT NULL OR cp.event_id IS NOT NULL)
 ) INTO has_tickets;
 IF has_tickets THEN
   RETURN public.confirm_sales_quote_ticket_sale(p_tenant_id,p_quote_id,p_expected_version,
     p_idempotency_key,p_actor_kind,p_actor_id);
 END IF;
 INSERT INTO public.sales_commercial_sale(tenant_id,quote_id,quote_version_id,opportunity_id,
   idempotency_key,confirmed_by_kind,confirmed_by_id)
 VALUES(p_tenant_id,q.id,v.id,q.opportunity_id,p_idempotency_key,p_actor_kind,p_actor_id) RETURNING * INTO s;
 UPDATE public.sales_quote_version SET status='converted',updated_at=now() WHERE id=v.id;
 UPDATE public.sales_quote SET row_version=row_version+1,updated_at=now(),updated_by=p_actor_id::text WHERE id=q.id;
 INSERT INTO public.sales_quote_status_history(tenant_id,quote_id,quote_version_id,from_status,to_status,
   actor_id,actor_type,note) VALUES(p_tenant_id,q.id,v.id,'accepted','converted',p_actor_id::text,p_actor_kind,'Commercial sale confirmed');
 IF q.opportunity_id IS NOT NULL THEN
   SELECT * INTO won FROM public.opportunity_stage WHERE tenant_id=p_tenant_id AND is_active AND is_won
    ORDER BY position,id LIMIT 1;
   IF NOT FOUND THEN RAISE EXCEPTION 'an active won opportunity stage is required' USING ERRCODE='23514'; END IF;
   INSERT INTO public.opportunity_stage_history(tenant_id,opportunity_id,from_stage_id,to_stage_id,
     actor_kind,actor_id,note)
   SELECT p_tenant_id,o.id,o.stage_id,won.id,p_actor_kind,p_actor_id,'Commercial sale confirmed'
    FROM public.opportunity o WHERE o.tenant_id=p_tenant_id AND o.id=q.opportunity_id;
   UPDATE public.opportunity SET stage_id=won.id,loss_reason_id=NULL,value_minor=v.gross_minor,
    currency=v.currency,version=version+1,updated_at=now()
    WHERE tenant_id=p_tenant_id AND id=q.opportunity_id;
   INSERT INTO public.opportunity_activity(tenant_id,opportunity_id,organization_id,actor_kind,actor_id,
     action,summary,metadata)
   SELECT p_tenant_id,o.id,o.organization_id,p_actor_kind,p_actor_id,'sale.confirmed',
    'Quote converted to a commercial sale',jsonb_build_object('quoteId',q.id,'saleId',s.id)
    FROM public.opportunity o WHERE o.tenant_id=p_tenant_id AND o.id=q.opportunity_id;
 END IF;
 RETURN jsonb_build_object('saleId',s.id,'idempotent',false);
END $$;

CREATE OR REPLACE FUNCTION public.decide_sales_quote_public(
 p_token_hash_hex text,p_decision text,p_customer_name text,p_customer_role text,
 p_purchase_order_reference text,p_customer_reference text,p_decline_reason text,
 p_agreement boolean,p_idempotency_key text,p_request_metadata jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.sales_quote_delivery_token%ROWTYPE; q public.sales_quote%ROWTYPE;
DECLARE v public.sales_quote_version%ROWTYPE; d public.sales_quote_customer_decision%ROWTYPE;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_token_hash_hex !~ '^[0-9a-f]{64}$' OR p_decision NOT IN ('accepted','declined')
   OR length(btrim(COALESCE(p_customer_name,''))) NOT BETWEEN 1 AND 200
    OR (p_decision='accepted' AND length(btrim(COALESCE(p_customer_role,''))) NOT BETWEEN 1 AND 200)
    OR length(COALESCE(p_customer_role,'')) > 200
    OR length(COALESCE(p_purchase_order_reference,'')) > 500
    OR length(COALESCE(p_customer_reference,'')) > 500
    OR length(COALESCE(p_decline_reason,'')) > 2000
   OR length(btrim(COALESCE(p_idempotency_key,''))) NOT BETWEEN 1 AND 200
   OR (p_decision='accepted' AND p_agreement IS NOT TRUE)
   OR jsonb_typeof(COALESCE(p_request_metadata,'{}'::jsonb))<>'object'
 THEN RAISE EXCEPTION 'invalid customer decision' USING ERRCODE='22023'; END IF;
 SELECT * INTO t FROM public.sales_quote_delivery_token
  WHERE token_hash=decode(p_token_hash_hex,'hex') FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
 IF t.activated_at IS NULL THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
 IF t.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('outcome','revoked'); END IF;
 IF t.expires_at<=now() THEN RETURN jsonb_build_object('outcome','expired'); END IF;
 SELECT * INTO q FROM public.sales_quote WHERE tenant_id=t.tenant_id AND id=t.quote_id FOR UPDATE;
 SELECT * INTO v FROM public.sales_quote_version WHERE tenant_id=t.tenant_id AND id=t.quote_version_id FOR UPDATE;
 IF q.current_version<>v.version_number OR v.status='superseded' THEN RETURN jsonb_build_object('outcome','superseded'); END IF;
 SELECT * INTO d FROM public.sales_quote_customer_decision
  WHERE tenant_id=t.tenant_id AND quote_version_id=v.id;
 IF FOUND THEN
   IF d.idempotency_key=p_idempotency_key AND d.decision=p_decision THEN
     RETURN jsonb_build_object('outcome',d.decision,'idempotent',true);
   END IF;
   RETURN jsonb_build_object('outcome','already_'||d.decision,'idempotent',false);
 END IF;
 IF v.status NOT IN ('issued','sent') THEN
   RETURN jsonb_build_object('outcome',v.status);
 END IF;
 INSERT INTO public.sales_quote_customer_decision(tenant_id,quote_id,quote_version_id,token_id,
   decision,customer_name,customer_role,purchase_order_reference,customer_reference,decline_reason,
   agreement,idempotency_key,request_metadata)
 VALUES(t.tenant_id,q.id,v.id,t.id,p_decision,btrim(p_customer_name),NULLIF(btrim(p_customer_role),''),
   NULLIF(btrim(p_purchase_order_reference),''),NULLIF(btrim(p_customer_reference),''),
   NULLIF(btrim(p_decline_reason),''),COALESCE(p_agreement,false),btrim(p_idempotency_key),
   COALESCE(p_request_metadata,'{}'::jsonb));
 INSERT INTO public.sales_quote_delivery_audit(tenant_id,quote_id,quote_version_id,token_id,event_type,
   recipient_email,request_metadata)
 VALUES(t.tenant_id,q.id,v.id,t.id,p_decision,t.recipient_email,COALESCE(p_request_metadata,'{}'::jsonb));
 IF p_decision='declined' THEN
   UPDATE public.sales_quote_version SET status='declined',updated_at=now() WHERE id=v.id;
   UPDATE public.sales_quote SET row_version=row_version+1,updated_at=now(),updated_by='customer' WHERE id=q.id;
   INSERT INTO public.sales_quote_status_history(tenant_id,quote_id,quote_version_id,from_status,to_status,
     actor_id,actor_type,note) VALUES(t.tenant_id,q.id,v.id,v.status,'declined','customer','customer','Customer declined quote');
   RETURN jsonb_build_object('outcome','declined','idempotent',false);
 END IF;
 UPDATE public.sales_quote_version SET status='accepted',updated_at=now() WHERE id=v.id;
 INSERT INTO public.sales_quote_status_history(tenant_id,quote_id,quote_version_id,from_status,to_status,
   actor_id,actor_type,note) VALUES(t.tenant_id,q.id,v.id,v.status,'accepted','customer','customer','Customer accepted quote');
 PERFORM public.confirm_sales_quote_sale(t.tenant_id,q.id,q.row_version,
   'public:'||p_idempotency_key,'customer',t.id);
 RETURN jsonb_build_object('outcome','accepted','idempotent',false);
END $$;

ALTER TABLE public.sales_quote_delivery_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_quote_delivery_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_quote_customer_decision ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_quote_delivery_token,public.sales_quote_delivery_audit,
 public.sales_quote_customer_decision FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.sales_quote_delivery_token TO service_role;
GRANT SELECT,INSERT ON public.sales_quote_delivery_audit,public.sales_quote_customer_decision TO service_role;
CREATE POLICY sales_quote_delivery_token_service ON public.sales_quote_delivery_token TO service_role USING(true) WITH CHECK(true);
CREATE POLICY sales_quote_delivery_audit_service ON public.sales_quote_delivery_audit TO service_role USING(true) WITH CHECK(true);
CREATE POLICY sales_quote_decision_service ON public.sales_quote_customer_decision TO service_role USING(true) WITH CHECK(true);
REVOKE ALL ON FUNCTION public.guard_sales_quote_delivery_append_only(),
 public.confirm_sales_quote_ticket_sale(uuid,uuid,integer,text,text,uuid),
 public.confirm_sales_quote_sale(uuid,uuid,integer,text,text,uuid),
 public.decide_sales_quote_public(text,text,text,text,text,text,text,boolean,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_sales_quote_ticket_sale(uuid,uuid,integer,text,text,uuid),
 public.confirm_sales_quote_sale(uuid,uuid,integer,text,text,uuid),
 public.decide_sales_quote_public(text,text,text,text,text,text,text,boolean,text,jsonb) TO service_role;
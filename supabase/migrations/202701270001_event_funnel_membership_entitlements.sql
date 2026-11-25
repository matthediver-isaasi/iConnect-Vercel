-- Event funnel complimentary membership stage.
--
-- A confirmed funnel order may grant eligibility for ONE free base-fee period
-- of an exact membership tier (organisation or individual). Checkout never
-- creates or activates a membership; the waiver applies once, when the next
-- matching membership history row is created. The benefit is never payment
-- evidence. Cancelling every qualifying booking withdraws an unused benefit;
-- a consumed benefit is never reversed.
--
-- NOT applied automatically. Requires owner approval under the rollout rules.
--
-- Backout (only while no entitlement has been consumed in production):
--   BEGIN;
--   DROP TRIGGER event_funnel_membership_payment_reserve ON public.membership_payment_quote;
--   DROP TRIGGER event_funnel_membership_form_reserve ON public.form_submission;
--   DROP FUNCTION public.reserve_event_funnel_membership_fee_token(uuid,uuid),
--     public.reserve_event_funnel_membership_payment(), public.reserve_event_funnel_membership_form(),
--     public.event_funnel_membership_reserve(uuid,jsonb,text,uuid,text,uuid,uuid,uuid);
--   DROP TABLE public.event_funnel_membership_reservation;
--   DROP FUNCTION public.guard_event_funnel_membership_reservation();
--   DROP TRIGGER event_funnel_membership_withdraw ON public.event_funnel_reversal;
--   DROP TRIGGER event_funnel_membership_grant ON public.event_funnel_order;
--   DROP TRIGGER event_funnel_membership_consume ON public.organisation_membership_history;
--   DROP TRIGGER event_funnel_membership_consume ON public.member_membership_history;
--   DROP TRIGGER event_funnel_membership_history_immutable ON public.organisation_membership_history;
--   DROP TRIGGER event_funnel_membership_history_immutable ON public.member_membership_history;
--   DROP FUNCTION public.event_funnel_membership_withdraw(), public.event_funnel_membership_grant(),
--     public.consume_event_funnel_membership_on_creation(), public.guard_event_funnel_membership_history(),
--     public.pending_event_funnel_membership(uuid,text,uuid,uuid), public.event_funnel_membership_ready(),
--     public.list_event_funnel_memberships(uuid,text,uuid), public.event_funnel_order_membership_outcome(uuid,uuid);
--   DROP TABLE public.event_funnel_membership_consumption, public.event_funnel_membership_entitlement;
--   ALTER TABLE public.organisation_membership_history DROP COLUMN funnel_membership;
--   ALTER TABLE public.member_membership_history DROP COLUMN funnel_membership;
--   -- Restore event_funnel_apply_journey from 202701230004 (skip-only decisions).
--   COMMIT;
-- If any consumption row exists, keep the tables and history columns: they are
-- the only evidence explaining a waived base fee.
BEGIN;
ALTER TABLE public.organisation_membership_history ADD COLUMN funnel_membership jsonb
  CHECK (funnel_membership IS NULL OR jsonb_typeof(funnel_membership)='object');
ALTER TABLE public.member_membership_history ADD COLUMN funnel_membership jsonb
  CHECK (funnel_membership IS NULL OR jsonb_typeof(funnel_membership)='object');

CREATE TABLE public.event_funnel_membership_entitlement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  node_id text NOT NULL,
  schedule_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('organization','member')),
  organization_id uuid,
  member_id uuid,
  recipient_id uuid GENERATED ALWAYS AS (coalesce(organization_id,member_id)) STORED,
  benefit_snapshot jsonb NOT NULL CHECK (jsonb_typeof(benefit_snapshot)='object'),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_at timestamptz,
  withdrawal_reason text CHECK (withdrawal_reason IS NULL OR withdrawal_reason='originating_booking_cancelled'),
  withdrawn_by_reversal uuid,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,order_id,node_id,recipient_id),
  CHECK ((scope='organization' AND organization_id IS NOT NULL AND member_id IS NULL)
    OR (scope='member' AND member_id IS NOT NULL AND organization_id IS NULL)),
  CHECK ((withdrawn_at IS NULL) = (withdrawal_reason IS NULL)),
  FOREIGN KEY (tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
CREATE INDEX event_funnel_membership_pending ON public.event_funnel_membership_entitlement
  (tenant_id,scope,recipient_id,schedule_id,granted_at) WHERE withdrawn_at IS NULL;

CREATE TABLE public.event_funnel_membership_consumption (
  entitlement_id uuid PRIMARY KEY REFERENCES public.event_funnel_membership_entitlement(id),
  tenant_id uuid NOT NULL,
  history_table text NOT NULL CHECK (history_table IN ('organisation_membership_history','member_membership_history')),
  history_id uuid NOT NULL,
  membership_year text NOT NULL,
  original_base_net_minor bigint NOT NULL CHECK (original_base_net_minor>=0),
  original_base_vat_minor bigint NOT NULL CHECK (original_base_vat_minor>=0),
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (history_table,history_id),
  FOREIGN KEY (tenant_id,entitlement_id) REFERENCES public.event_funnel_membership_entitlement(tenant_id,id)
);

ALTER TABLE public.event_funnel_membership_entitlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_membership_consumption ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_membership_entitlement,public.event_funnel_membership_consumption
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.event_funnel_membership_entitlement,public.event_funnel_membership_consumption TO service_role;

-- Evidence is immutable. The only permitted change is one withdrawal of an
-- entitlement that has not been consumed.
CREATE FUNCTION public.guard_event_funnel_membership_entitlement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  -- Nested: the consumption table shares this guard and has no withdrawn_at.
  IF TG_TABLE_NAME='event_funnel_membership_entitlement' AND TG_OP='UPDATE' THEN
  IF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL
    -- recipient_id is generated (NULL in BEFORE-trigger NEW); its inputs are compared.
    AND (to_jsonb(OLD)-ARRAY['withdrawn_at','withdrawal_reason','withdrawn_by_reversal','recipient_id'])
      =(to_jsonb(NEW)-ARRAY['withdrawn_at','withdrawal_reason','withdrawn_by_reversal','recipient_id'])
    AND NOT EXISTS(SELECT 1 FROM public.event_funnel_membership_consumption c WHERE c.entitlement_id=OLD.id) THEN
    RETURN NEW;
  END IF;
  END IF;
  RAISE EXCEPTION 'Event booking membership benefit evidence is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER event_funnel_membership_entitlement_immutable BEFORE UPDATE OR DELETE
  ON public.event_funnel_membership_entitlement FOR EACH ROW EXECUTE FUNCTION public.guard_event_funnel_membership_entitlement();
CREATE TRIGGER event_funnel_membership_consumption_immutable BEFORE UPDATE OR DELETE
  ON public.event_funnel_membership_consumption FOR EACH ROW EXECUTE FUNCTION public.guard_event_funnel_membership_entitlement();

-- Payment reservations: a checkout that will charge add-ons against a
-- complimentary period reserves the benefit before any provider payment, so a
-- second checkout cannot consume it while the first payment is in flight.
-- Exactly one owner: a saved payment quote, a form submission or a fee link.
CREATE TABLE public.event_funnel_membership_reservation (
  entitlement_id uuid PRIMARY KEY REFERENCES public.event_funnel_membership_entitlement(id),
  payment_quote_id uuid UNIQUE REFERENCES public.membership_payment_quote(id),
  submission_id uuid UNIQUE REFERENCES public.form_submission(id),
  fee_token_id uuid UNIQUE REFERENCES public.membership_fee_token(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT event_funnel_membership_reservation_one_owner CHECK(
    (payment_quote_id IS NOT NULL)::integer+(submission_id IS NOT NULL)::integer+(fee_token_id IS NOT NULL)::integer=1)
);
ALTER TABLE public.event_funnel_membership_reservation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_membership_reservation FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.event_funnel_membership_reservation TO service_role;
CREATE FUNCTION public.guard_event_funnel_membership_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Event booking membership reservations are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER event_funnel_membership_reservation_immutable BEFORE UPDATE OR DELETE
  ON public.event_funnel_membership_reservation FOR EACH ROW EXECUTE FUNCTION public.guard_event_funnel_membership_reservation();

-- Shared check-and-reserve. Locks the recipient, then the entitlement row, so
-- it serializes with consumption and withdrawal.
CREATE FUNCTION public.event_funnel_membership_reserve(p_tenant uuid,p_benefit jsonb,p_scope text,p_recipient uuid,
  p_schedule text,p_quote uuid,p_submission uuid,p_token uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.event_funnel_membership_entitlement%ROWTYPE; r public.event_funnel_membership_reservation%ROWTYPE;
BEGIN
  IF p_scope='organization' THEN
    PERFORM 1 FROM public.organization WHERE tenant_id=p_tenant AND id=p_recipient FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.member WHERE tenant_id=p_tenant AND id=p_recipient FOR UPDATE;
  END IF;
  SELECT * INTO e FROM public.event_funnel_membership_entitlement WHERE tenant_id=p_tenant
    AND id::text=p_benefit->>'entitlementId' FOR UPDATE;
  IF e.id IS NULL OR e.scope IS DISTINCT FROM p_scope OR e.recipient_id IS DISTINCT FROM p_recipient
    OR e.schedule_id::text IS DISTINCT FROM p_schedule OR e.schedule_id::text IS DISTINCT FROM p_benefit->>'scheduleId' THEN
    RAISE EXCEPTION 'Event booking membership benefit does not match this checkout; recalculate before payment' USING ERRCODE='22023';
  END IF;
  SELECT * INTO r FROM public.event_funnel_membership_reservation WHERE entitlement_id=e.id;
  IF FOUND THEN
    IF r.payment_quote_id IS NOT DISTINCT FROM p_quote AND r.submission_id IS NOT DISTINCT FROM p_submission
      AND r.fee_token_id IS NOT DISTINCT FROM p_token THEN RETURN; END IF;
    RAISE EXCEPTION 'This event booking membership benefit is reserved by another checkout; resume that checkout' USING ERRCODE='PT409';
  END IF;
  IF e.withdrawn_at IS NOT NULL OR EXISTS(SELECT 1 FROM public.event_funnel_membership_consumption c WHERE c.entitlement_id=e.id) THEN
    RAISE EXCEPTION 'Event booking membership benefit is no longer available; recalculate before payment' USING ERRCODE='PT409';
  END IF;
  INSERT INTO public.event_funnel_membership_reservation(entitlement_id,payment_quote_id,submission_id,fee_token_id)
    VALUES(e.id,p_quote,p_submission,p_token);
END $$;

CREATE FUNCTION public.reserve_event_funnel_membership_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE benefit jsonb:=nullif(NEW.quote#>'{simResult,funnelMembership}','null'::jsonb);
BEGIN
  IF benefit IS NULL THEN RETURN NEW; END IF;
  PERFORM public.event_funnel_membership_reserve(NEW.tenant_id,benefit,benefit->>'scope',
    CASE WHEN benefit->>'scope'='organization' THEN NEW.organization_id ELSE NEW.member_id END,
    NEW.quote#>>'{simResult,config,id}',NEW.id,NULL,NULL);
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_membership_payment_reserve AFTER INSERT ON public.membership_payment_quote
  FOR EACH ROW EXECUTE FUNCTION public.reserve_event_funnel_membership_payment();

CREATE FUNCTION public.reserve_event_funnel_membership_form() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE benefit jsonb:=nullif(NEW.payment_meta#>'{membership,quote,funnel_membership}','null'::jsonb);
BEGIN
  IF benefit IS NULL THEN RETURN NEW; END IF;
  PERFORM public.event_funnel_membership_reserve(NEW.tenant_id,benefit,benefit->>'scope',
    CASE WHEN benefit->>'scope'='organization' THEN (NEW.payment_meta->>'prefill_organization_id')::uuid
      ELSE (to_jsonb(NEW)->>'member_id')::uuid END,
    NEW.payment_meta#>>'{membership,quote,config_id}',NULL,NEW.id,NULL);
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_membership_form_reserve AFTER INSERT OR UPDATE OF payment_meta ON public.form_submission
  FOR EACH ROW EXECUTE FUNCTION public.reserve_event_funnel_membership_form();

-- Called before creating a provider payment from an emailed fee link.
CREATE FUNCTION public.reserve_event_funnel_membership_fee_token(p_tenant uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t jsonb; benefit jsonb;
BEGIN
  SELECT to_jsonb(x) INTO t FROM public.membership_fee_token x WHERE x.tenant_id=p_tenant AND x.id=p_token;
  benefit:=nullif(t#>'{cost_breakdown,funnelMembership}','null'::jsonb);
  IF t IS NULL OR benefit IS NULL THEN
    RAISE EXCEPTION 'Membership fee quote is unavailable' USING ERRCODE='22023';
  END IF;
  -- A fee link that already created its own (unpaid) history has consumed
  -- the benefit for this checkout; payment may proceed.
  IF EXISTS(SELECT 1 FROM public.event_funnel_membership_consumption c
    WHERE c.tenant_id=p_tenant AND c.entitlement_id::text=benefit->>'entitlementId' AND (
      EXISTS(SELECT 1 FROM public.organisation_membership_history h WHERE c.history_table='organisation_membership_history'
        AND h.id=c.history_id AND h.funnel_membership->>'feeTokenId'=p_token::text)
      OR EXISTS(SELECT 1 FROM public.member_membership_history h WHERE c.history_table='member_membership_history'
        AND h.id=c.history_id AND h.funnel_membership->>'feeTokenId'=p_token::text))) THEN
    RETURN true;
  END IF;
  PERFORM public.event_funnel_membership_reserve(p_tenant,benefit,benefit->>'scope',
    (CASE WHEN benefit->>'scope'='organization' THEN t->>'organization_id' ELSE t->>'member_id' END)::uuid,
    benefit->>'scheduleId',NULL,NULL,p_token);
  RETURN true;
END $$;

-- Grant: same transaction as the order's confirmation. Server-built plan
-- evidence is re-verified against the published graph, the session's accepted
-- decision, tenant-owned recipients and the committed registrations.
CREATE FUNCTION public.event_funnel_membership_grant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE m jsonb; rcp jsonb; node jsonb; journey jsonb; session_member uuid; schedule jsonb;
  v_scope text; v_recipient uuid; member_row jsonb; booking_ids jsonb; qualifying jsonb; booking text; graph_entry text;
BEGIN
  IF NEW.state IS DISTINCT FROM 'confirmed' OR OLD.state='confirmed' THEN RETURN NEW; END IF;
  IF jsonb_typeof(coalesce(NEW.snapshot->'memberships','[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid membership benefit evidence' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(coalesce(NEW.snapshot->'memberships','[]'::jsonb))=0 THEN RETURN NEW; END IF;
  SELECT s.journey,s.member_id INTO journey,session_member FROM public.event_funnel_session s
    WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.session_id;
  FOR m IN SELECT value FROM jsonb_array_elements(NEW.snapshot->'memberships') LOOP
    SELECT v.graph->>'entry' INTO graph_entry FROM public.event_funnel_version v WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.version_id;
    node:=NULL;
    SELECT n INTO node FROM public.event_funnel_version v CROSS JOIN LATERAL jsonb_array_elements(v.graph->'nodes') n
      WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.version_id AND n->>'id'=m->>'nodeId' AND n->>'type'='membership';
    v_scope:=m->>'scope';
    IF node IS NULL OR journey#>>ARRAY['decisions',m->>'nodeId'] IS DISTINCT FROM 'accept'
      OR node#>>'{membership,scheduleId}' IS DISTINCT FROM m->>'scheduleId'
      OR node#>>'{membership,scope}' IS DISTINCT FROM v_scope
      OR node#>>'{membership,recipientMode}' IS DISTINCT FROM m->>'recipientMode'
      OR jsonb_typeof(m->'recipients') IS DISTINCT FROM 'array' OR jsonb_array_length(m->'recipients') NOT BETWEEN 1 AND 1000
      OR jsonb_typeof(m->'qualifyingNodeIds') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid membership benefit evidence' USING ERRCODE='22023';
    END IF;
    qualifying:=CASE WHEN jsonb_array_length(coalesce(node->'requires','[]'::jsonb))>0 THEN node->'requires'
      ELSE jsonb_build_array(graph_entry) END;
    IF (SELECT coalesce(jsonb_agg(x ORDER BY x),'[]') FROM jsonb_array_elements_text(m->'qualifyingNodeIds') x)
      IS DISTINCT FROM (SELECT coalesce(jsonb_agg(x ORDER BY x),'[]') FROM jsonb_array_elements_text(qualifying) x) THEN
      RAISE EXCEPTION 'Invalid membership benefit prerequisites' USING ERRCODE='22023';
    END IF;
    SELECT to_jsonb(c) INTO schedule FROM public.membership_tier_config c
      WHERE c.tenant_id=NEW.tenant_id AND c.id=(m->>'scheduleId')::uuid;
    IF schedule IS NULL OR (CASE WHEN schedule->>'structure_scope_type'='member' THEN 'member' ELSE 'organization' END) IS DISTINCT FROM v_scope THEN
      RAISE EXCEPTION 'Membership tier is no longer available' USING ERRCODE='PT409';
    END IF;
    FOR rcp IN SELECT value FROM jsonb_array_elements(m->'recipients') LOOP
      v_recipient:=(rcp->>'id')::uuid; booking_ids:=rcp->'bookingIds';
      IF rcp->>'kind' IS DISTINCT FROM v_scope OR jsonb_typeof(booking_ids) IS DISTINCT FROM 'array'
        OR jsonb_array_length(booking_ids)=0 THEN
        RAISE EXCEPTION 'Invalid membership recipient evidence' USING ERRCODE='22023';
      END IF;
      FOR booking IN SELECT jsonb_array_elements_text(booking_ids) LOOP
        IF NOT EXISTS(SELECT 1 FROM public.event_funnel_order_booking b WHERE b.tenant_id=NEW.tenant_id
          AND b.order_id=NEW.id AND b.booking_id::text=booking AND b.node_id IN (SELECT jsonb_array_elements_text(qualifying))) THEN
          RAISE EXCEPTION 'Membership benefit is not linked to a qualifying booking' USING ERRCODE='22023';
        END IF;
      END LOOP;
      IF v_scope='organization' THEN
        SELECT to_jsonb(x) INTO member_row FROM public.member x WHERE x.tenant_id=NEW.tenant_id AND x.id=session_member;
        IF member_row IS NULL OR member_row->>'organization_id' IS DISTINCT FROM v_recipient::text
          OR NOT EXISTS(SELECT 1 FROM public.organization o WHERE o.tenant_id=NEW.tenant_id AND o.id=v_recipient) THEN
          RAISE EXCEPTION 'Membership recipient is not the purchaser''s organisation' USING ERRCODE='PT409';
        END IF;
      ELSE
        SELECT to_jsonb(x) INTO member_row FROM public.member x WHERE x.tenant_id=NEW.tenant_id AND x.id=v_recipient;
        IF member_row IS NULL THEN RAISE EXCEPTION 'Membership recipient is unavailable' USING ERRCODE='PT409'; END IF;
        IF m->>'recipientMode'='purchaser' AND v_recipient IS DISTINCT FROM session_member THEN
          RAISE EXCEPTION 'Membership recipient is not the purchaser' USING ERRCODE='PT409';
        END IF;
        IF m->>'recipientMode'='attendees' AND EXISTS(
          SELECT 1 FROM jsonb_array_elements_text(booking_ids) bid WHERE NOT EXISTS(
            SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'registrations') r
            WHERE r->>'id'=bid AND lower(btrim(r#>>'{row,attendee_email}'))=lower(btrim(member_row->>'email')))) THEN
          RAISE EXCEPTION 'Membership recipient is not a named attendee' USING ERRCODE='PT409';
        END IF;
      END IF;
      INSERT INTO public.event_funnel_membership_entitlement(tenant_id,order_id,node_id,schedule_id,scope,organization_id,member_id,benefit_snapshot)
        VALUES(NEW.tenant_id,NEW.id,m->>'nodeId',(m->>'scheduleId')::uuid,v_scope,
          CASE WHEN v_scope='organization' THEN v_recipient END,CASE WHEN v_scope='member' THEN v_recipient END,
          jsonb_build_object('version',1,'source','event_funnel','coverage','next_new_period','periods',1,'baseFeeOnly',true,
            'scope',v_scope,'scheduleId',m->>'scheduleId','scheduleName',schedule->>'name',
            'recipientMode',m->>'recipientMode','orderId',NEW.id,'nodeId',m->>'nodeId',
            'qualifyingNodeIds',qualifying,'qualifyingBookingIds',booking_ids))
        ON CONFLICT (tenant_id,order_id,node_id,recipient_id) DO NOTHING;
    END LOOP;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_membership_grant AFTER UPDATE OF state ON public.event_funnel_order
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_membership_grant();

CREATE FUNCTION public.pending_event_funnel_membership(p_tenant uuid,p_scope text,p_recipient uuid,p_schedule uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT to_jsonb(e) FROM public.event_funnel_membership_entitlement e
  WHERE e.tenant_id=p_tenant AND e.scope=p_scope AND e.recipient_id=p_recipient AND e.schedule_id=p_schedule
    AND e.withdrawn_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.event_funnel_membership_consumption c WHERE c.entitlement_id=e.id)
  ORDER BY e.granted_at,e.id LIMIT 1
$$;

-- Consumption: one base-fee waiver on the next created matching period.
-- Proposal coverage takes precedence; only one complimentary benefit applies.
CREATE FUNCTION public.consume_event_funnel_membership_on_creation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
-- to_jsonb renders SQL NULL columns as JSON null; normalize back to SQL NULL.
DECLARE r jsonb:=to_jsonb(NEW); snapshot jsonb:=nullif(to_jsonb(NEW)->'funnel_membership','null'::jsonb);
  v_scope text; v_recipient uuid; e public.event_funnel_membership_entitlement%ROWTYPE; net bigint; vat bigint;
BEGIN
  IF TG_TABLE_NAME='organisation_membership_history' THEN
    v_scope:='organization'; v_recipient:=(r->>'organization_id')::uuid;
    PERFORM 1 FROM public.organization WHERE id=v_recipient AND tenant_id=NEW.tenant_id FOR UPDATE;
  ELSE
    v_scope:='member'; v_recipient:=(r->>'member_id')::uuid;
    PERFORM 1 FROM public.member WHERE id=v_recipient AND tenant_id=NEW.tenant_id FOR UPDATE;
  END IF;
  IF jsonb_typeof(r->'proposal_membership')='object' THEN
    IF snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'Only one complimentary membership benefit can apply to a period' USING ERRCODE='22023';
    END IF;
    RETURN NEW;
  END IF;
  SELECT x.* INTO e FROM public.event_funnel_membership_entitlement x
    WHERE x.tenant_id=NEW.tenant_id AND x.scope=v_scope AND x.recipient_id=v_recipient
      AND x.schedule_id=(r->>'config_id')::uuid AND x.withdrawn_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.event_funnel_membership_consumption c WHERE c.entitlement_id=x.id)
    ORDER BY x.granted_at,x.id LIMIT 1 FOR UPDATE;
  IF e.id IS NULL THEN
    IF snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'Event booking membership benefit is no longer available; recalculate before creating membership' USING ERRCODE='PT409';
    END IF;
    RETURN NEW;
  END IF;
  IF snapshot IS NULL OR snapshot->>'entitlementId' IS DISTINCT FROM e.id::text
    OR snapshot->>'scheduleId' IS DISTINCT FROM e.schedule_id::text
    OR snapshot->>'orderId' IS DISTINCT FROM e.order_id::text THEN
    RAISE EXCEPTION 'An available event booking membership benefit must be recalculated before creating this membership' USING ERRCODE='PT409';
  END IF;
  IF jsonb_typeof(snapshot->'originalBaseNetMinor') IS DISTINCT FROM 'number'
    OR jsonb_typeof(snapshot->'originalBaseVatMinor') IS DISTINCT FROM 'number'
    OR NOT (snapshot->>'originalBaseNetMinor' ~ '^[0-9]+$')
    OR NOT (snapshot->>'originalBaseVatMinor' ~ '^[0-9]+$') THEN
    RAISE EXCEPTION 'Original membership fee evidence is invalid' USING ERRCODE='22023';
  END IF;
  net:=(snapshot->>'originalBaseNetMinor')::bigint; vat:=(snapshot->>'originalBaseVatMinor')::bigint;
  IF r->>'billing_agreement_id' IS NOT NULL THEN
    RAISE EXCEPTION 'Existing payment agreements cannot be converted to complimentary coverage; review before creating membership' USING ERRCODE='PT409';
  END IF;
  IF EXISTS(SELECT 1 FROM public.event_funnel_membership_reservation x WHERE x.entitlement_id=e.id AND (
      (x.payment_quote_id IS NOT NULL AND x.payment_quote_id::text IS DISTINCT FROM r->>'membership_payment_quote_id')
      OR (x.submission_id IS NOT NULL AND x.submission_id::text IS DISTINCT FROM snapshot->>'submissionId')
      OR (x.fee_token_id IS NOT NULL AND x.fee_token_id::text IS DISTINCT FROM snapshot->>'feeTokenId'))) THEN
    RAISE EXCEPTION 'This event booking membership benefit is reserved by a payment checkout; resume that checkout' USING ERRCODE='PT409';
  END IF;
  INSERT INTO public.event_funnel_membership_consumption(entitlement_id,tenant_id,history_table,history_id,membership_year,
    original_base_net_minor,original_base_vat_minor)
    VALUES(e.id,NEW.tenant_id,TG_TABLE_NAME,(r->>'id')::uuid,r->>'membership_year',net,vat);
  IF coalesce((r->>'total_with_vat')::numeric,(r->>'final_cost')::numeric)=0 THEN
    -- 'paid' is the legacy access state, not payment evidence: keep receipt
    -- evidence empty and use an explicit non-payment method.
    NEW:=jsonb_populate_record(NEW,jsonb_build_object('payment_status','paid','payment_method','event_funnel_entitlement',
      'paid_at',NULL,'stripe_payment_intent_id',NULL));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_membership_consume BEFORE INSERT ON public.organisation_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.consume_event_funnel_membership_on_creation();
CREATE TRIGGER event_funnel_membership_consume BEFORE INSERT ON public.member_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.consume_event_funnel_membership_on_creation();

CREATE FUNCTION public.guard_event_funnel_membership_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE o jsonb:=to_jsonb(OLD); n jsonb:=to_jsonb(NEW);
  keys text[]:=ARRAY['tenant_id','organization_id','member_id','config_id','membership_year','final_cost',
    'total_with_vat','currency','vat_amount','annual_cost'];
BEGIN
  IF o->'funnel_membership' IS DISTINCT FROM n->'funnel_membership'
    OR (jsonb_typeof(o->'funnel_membership')='object' AND EXISTS(
      SELECT 1 FROM unnest(keys) k WHERE o->k IS DISTINCT FROM n->k)) THEN
    RAISE EXCEPTION 'Complimentary membership amounts and provenance are immutable' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(o->'funnel_membership')='object' AND o->>'payment_method'='event_funnel_entitlement'
    AND (n->>'paid_at' IS NOT NULL OR n->>'payment_method' IS DISTINCT FROM o->>'payment_method') THEN
    RAISE EXCEPTION 'Complimentary membership is not evidence of payment receipt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_membership_history_immutable BEFORE UPDATE ON public.organisation_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_funnel_membership_history();
CREATE TRIGGER event_funnel_membership_history_immutable BEFORE UPDATE ON public.member_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_funnel_membership_history();

-- Withdrawal: when every qualifying booking for a recipient has a committed
-- cancellation, withdraw an unused entitlement. Never touch a consumed one.
CREATE FUNCTION public.event_funnel_membership_withdraw() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.event_funnel_membership_entitlement%ROWTYPE;
BEGIN
  IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL THEN RETURN NEW; END IF;
  FOR e IN SELECT * FROM public.event_funnel_membership_entitlement x
    WHERE x.tenant_id=NEW.tenant_id AND x.order_id=NEW.order_id AND x.withdrawn_at IS NULL ORDER BY x.id FOR UPDATE LOOP
    -- Separate statement after the lock: sees any consumption committed first.
    CONTINUE WHEN EXISTS(SELECT 1 FROM public.event_funnel_membership_consumption c WHERE c.entitlement_id=e.id);
    -- A checkout holding the benefit may already be charging add-ons against
    -- it: never withdraw underneath it. Reported as 'reserved' for review.
    CONTINUE WHEN EXISTS(SELECT 1 FROM public.event_funnel_membership_reservation x WHERE x.entitlement_id=e.id);
    CONTINUE WHEN EXISTS(
      SELECT 1 FROM jsonb_array_elements_text(e.benefit_snapshot->'qualifyingBookingIds') bid
      WHERE NOT EXISTS(SELECT 1 FROM public.event_funnel_reversal r CROSS JOIN LATERAL jsonb_array_elements(r.allocations) a
        WHERE r.tenant_id=e.tenant_id AND r.order_id=e.order_id AND r.cancelled_at IS NOT NULL AND r.state<>'released'
          AND a->>'id'=bid));
    UPDATE public.event_funnel_membership_entitlement SET withdrawn_at=clock_timestamp(),
      withdrawal_reason='originating_booking_cancelled',withdrawn_by_reversal=NEW.id WHERE id=e.id;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_membership_withdraw AFTER UPDATE OF cancelled_at ON public.event_funnel_reversal
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_membership_withdraw();

-- Cancellation review outcome for one order.
CREATE FUNCTION public.event_funnel_order_membership_outcome(p_tenant uuid,p_order uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'scope',e.scope,'scheduleName',e.benefit_snapshot->>'scheduleName',
    'state',CASE WHEN c.entitlement_id IS NOT NULL THEN 'consumed' WHEN e.withdrawn_at IS NOT NULL THEN 'withdrawn'
      WHEN EXISTS(SELECT 1 FROM public.event_funnel_membership_reservation x WHERE x.entitlement_id=e.id) THEN 'reserved' ELSE 'available' END,
    'withdrawnAt',e.withdrawn_at,'consumedAt',c.consumed_at) ORDER BY e.granted_at,e.id),'[]'::jsonb)
  FROM public.event_funnel_membership_entitlement e
  LEFT JOIN public.event_funnel_membership_consumption c ON c.entitlement_id=e.id
  WHERE e.tenant_id=p_tenant AND e.order_id=p_order
$$;

-- Membership screens: funnel-granted benefits with their source.
CREATE FUNCTION public.list_event_funnel_memberships(p_tenant uuid,p_scope text,p_recipient uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'scheduleId',e.schedule_id,
    'scheduleName',e.benefit_snapshot->>'scheduleName','grantedAt',e.granted_at,
    'state',CASE WHEN c.entitlement_id IS NOT NULL THEN 'consumed' WHEN e.withdrawn_at IS NOT NULL THEN 'withdrawn'
      WHEN EXISTS(SELECT 1 FROM public.event_funnel_membership_reservation x WHERE x.entitlement_id=e.id) THEN 'reserved' ELSE 'available' END,
    'withdrawnAt',e.withdrawn_at,
    'consumption',CASE WHEN c.entitlement_id IS NULL THEN NULL ELSE jsonb_build_object('membershipYear',c.membership_year,
      'consumedAt',c.consumed_at,'originalBaseNetMinor',c.original_base_net_minor,'originalBaseVatMinor',c.original_base_vat_minor) END,
    'source',jsonb_build_object('funnelName',d.name,'orderedAt',o.created_at)) ORDER BY e.granted_at,e.id),'[]'::jsonb)
  FROM public.event_funnel_membership_entitlement e
  JOIN public.event_funnel_order o ON o.tenant_id=e.tenant_id AND o.id=e.order_id
  LEFT JOIN public.event_funnel_version v ON v.tenant_id=o.tenant_id AND v.id=o.version_id
  LEFT JOIN public.event_funnel_definition d ON d.tenant_id=v.tenant_id AND d.id=v.definition_id
  LEFT JOIN public.event_funnel_membership_consumption c ON c.entitlement_id=e.id
  WHERE e.tenant_id=p_tenant AND e.scope=p_scope AND e.recipient_id=p_recipient
$$;

-- Admin membership Start: carry the benefit evidence resolved at preview so
-- a No charge Start for a member with an unused benefit is not rejected.
DO $patch$
DECLARE d text; patched text;
BEGIN
  SELECT pg_get_functiondef('public.create_member_start(uuid,uuid,uuid,text,jsonb,jsonb)'::regprocedure) INTO d;
  patched:=replace(d,'INSERT INTO member_membership_history (tenant_id,member_id,','INSERT INTO member_membership_history (tenant_id,member_id,funnel_membership,');
  patched:=replace(patched,'VALUES (p_tenant_id,p_member_id,','VALUES (p_tenant_id,p_member_id,nullif(p_quote->''funnelMembership'',''null''::jsonb),');
  IF (length(patched)-length(d)) IS DISTINCT FROM length('funnel_membership,')+length('nullif(p_quote->''funnelMembership'',''null''::jsonb),') THEN
    RAISE EXCEPTION 'Unexpected member start baseline';
  END IF;
  EXECUTE patched;
END $patch$;

CREATE FUNCTION public.event_funnel_membership_ready() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

-- Journey decisions: membership offers record an explicit accept or skip;
-- purchasing offers keep skip-only decisions.
DO $patch$
DECLARE original text; patched text;
  needle text:='node->>''type'' NOT IN (''event'',''addon'') OR decision.value IS DISTINCT FROM ''"skip"''::jsonb';
BEGIN
  SELECT pg_get_functiondef('public.event_funnel_apply_journey(uuid,uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,boolean,jsonb)'::regprocedure)
    INTO original;
  patched:=replace(original,needle,'NOT ((node->>''type'' IN (''event'',''addon'') AND decision.value=''"skip"''::jsonb)'
    ||' OR (node->>''type''=''membership'' AND decision.value IN (''"skip"''::jsonb,''"accept"''::jsonb)))');
  IF patched=original THEN RAISE EXCEPTION 'Unexpected journey decision baseline'; END IF;
  EXECUTE patched;
END $patch$;

REVOKE ALL ON FUNCTION public.guard_event_funnel_membership_entitlement(),public.event_funnel_membership_grant(),
  public.consume_event_funnel_membership_on_creation(),public.guard_event_funnel_membership_history(),
  public.event_funnel_membership_withdraw(),public.guard_event_funnel_membership_reservation(),
  public.event_funnel_membership_reserve(uuid,jsonb,text,uuid,text,uuid,uuid,uuid),
  public.reserve_event_funnel_membership_payment(),public.reserve_event_funnel_membership_form()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.pending_event_funnel_membership(uuid,text,uuid,uuid),
  public.event_funnel_order_membership_outcome(uuid,uuid),public.list_event_funnel_memberships(uuid,text,uuid),
  public.event_funnel_membership_ready(),public.reserve_event_funnel_membership_fee_token(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pending_event_funnel_membership(uuid,text,uuid,uuid),
  public.event_funnel_order_membership_outcome(uuid,uuid),public.list_event_funnel_memberships(uuid,text,uuid),
  public.event_funnel_membership_ready(),public.reserve_event_funnel_membership_fee_token(uuid,uuid) TO service_role;
COMMIT;

-- Individually identifiable exhibition inventory. No historical sales backfill.
ALTER TABLE public.sales_quote ADD COLUMN exhibition_deleted_at timestamptz;
CREATE TABLE public.sales_space_requirement (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 255),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,name)
);
ALTER TABLE public.sales_catalogue_product ADD COLUMN space_requirement_id uuid;
ALTER TABLE public.sales_catalogue_product ADD CONSTRAINT sales_product_space_requirement_fk
 FOREIGN KEY(tenant_id,space_requirement_id) REFERENCES public.sales_space_requirement(tenant_id,id);
CREATE TABLE public.sales_space_group (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 requirement_id uuid NOT NULL, event_id uuid NOT NULL, event_kind text NOT NULL CHECK(event_kind IN ('simple','complex')),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 255),
 prefix text NOT NULL CHECK(prefix ~ '^[A-Z0-9][A-Z0-9_-]{0,47}$'),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), next_ordinal integer NOT NULL DEFAULT 1 CHECK(next_ordinal>0),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,event_kind,event_id,prefix),
 FOREIGN KEY(tenant_id,requirement_id) REFERENCES public.sales_space_requirement(tenant_id,id)
);
CREATE TABLE public.sales_exhibition_space (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, group_id uuid NOT NULL,
 event_id uuid NOT NULL, event_kind text NOT NULL CHECK(event_kind IN ('simple','complex')),
 reference text NOT NULL CHECK(reference=upper(btrim(reference))), price_minor bigint NOT NULL CHECK(price_minor BETWEEN 0 AND 9007199254740991),
 blocked boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,event_kind,event_id,reference),
 FOREIGN KEY(tenant_id,group_id) REFERENCES public.sales_space_group(tenant_id,id)
);
CREATE TABLE public.sales_space_allocation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, space_id uuid NOT NULL,
 quote_id uuid NOT NULL, slot_key text NOT NULL CHECK(length(slot_key) BETWEEN 1 AND 300),
 state text NOT NULL CHECK(state IN ('reserved','sold','released')),
 reference text NOT NULL, price_minor bigint NOT NULL CHECK(price_minor BETWEEN 0 AND 9007199254740991),
 currency text NOT NULL, event_id uuid NOT NULL, event_kind text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz, sold_at timestamptz,
 FOREIGN KEY(tenant_id,space_id) REFERENCES public.sales_exhibition_space(tenant_id,id),
 FOREIGN KEY(tenant_id,quote_id) REFERENCES public.sales_quote(tenant_id,id)
);
CREATE UNIQUE INDEX sales_space_exclusive_owner ON public.sales_space_allocation(tenant_id,space_id) WHERE state IN ('reserved','sold');
CREATE UNIQUE INDEX sales_space_exclusive_slot ON public.sales_space_allocation(tenant_id,quote_id,slot_key) WHERE state IN ('reserved','sold');
CREATE INDEX sales_space_quote_lookup ON public.sales_space_allocation(tenant_id,quote_id);
CREATE TABLE public.sales_space_command (
 tenant_id uuid NOT NULL, command_key text NOT NULL CHECK(length(command_key) BETWEEN 1 AND 200),
 payload jsonb NOT NULL, result jsonb NOT NULL, PRIMARY KEY(tenant_id,command_key)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sales_space_requirement','sales_space_group','sales_exhibition_space','sales_space_allocation','sales_space_command'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
 EXECUTE format('GRANT SELECT ON public.%I TO service_role',t);
 EXECUTE format('CREATE POLICY service_read ON public.%I FOR SELECT TO service_role USING(true)',t);
 END LOOP;
END $$;

CREATE FUNCTION public.sales_space_lock(p_tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR p_tenant IS NULL THEN
 RAISE EXCEPTION 'service tenant required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('sales-exhibition:'||p_tenant::text,0));
END $$;

CREATE FUNCTION public.manage_sales_exhibition(p_tenant uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g public.sales_space_group%ROWTYPE; s public.sales_exhibition_space%ROWTYPE; c public.sales_space_command%ROWTYPE;
 r uuid; n integer; price bigint; result jsonb; i integer; key text;
BEGIN
 PERFORM public.sales_space_lock(p_tenant);
 IF p_command IS NULL OR jsonb_typeof(p_command)<>'object' THEN RAISE EXCEPTION 'invalid command' USING ERRCODE='22023'; END IF;
 IF p_command->>'action'='requirement' THEN
 INSERT INTO public.sales_space_requirement(tenant_id,name) VALUES(p_tenant,btrim(p_command->>'name')) RETURNING id INTO r;
 RETURN jsonb_build_object('id',r,'name',btrim(p_command->>'name'));
 ELSIF p_command->>'action'='generate' THEN
 key:=p_command->>'idempotencyKey';
 IF key IS NULL OR length(key) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'idempotencyKey required' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM public.sales_space_command WHERE tenant_id=p_tenant AND command_key=key;
 IF FOUND THEN
 IF c.payload<>p_command THEN RAISE EXCEPTION 'idempotency key reused with different command' USING ERRCODE='40001'; END IF;
 RETURN c.result;
 END IF;
 n:=(p_command->>'quantity')::integer; price:=(p_command->>'priceMinor')::bigint;
 IF n IS NULL OR n NOT BETWEEN 1 AND 1000 OR price IS NULL OR price NOT BETWEEN 0 AND 9007199254740991 THEN
 RAISE EXCEPTION 'invalid quantity or price' USING ERRCODE='22023'; END IF;
 IF NULLIF(p_command->>'groupId','') IS NOT NULL THEN
 SELECT * INTO g FROM public.sales_space_group WHERE tenant_id=p_tenant AND id=(p_command->>'groupId')::uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'group not found' USING ERRCODE='P0002'; END IF;
 ELSE
 IF p_command->>'eventKind'='simple' THEN
 PERFORM 1 FROM public.event WHERE tenant_id=p_tenant AND id=(p_command->>'eventId')::uuid FOR KEY SHARE;
 ELSIF p_command->>'eventKind'='complex' THEN
 PERFORM 1 FROM public.complex_event WHERE tenant_id=p_tenant AND id=(p_command->>'eventId')::uuid FOR KEY SHARE;
 ELSE RAISE EXCEPTION 'invalid event kind' USING ERRCODE='22023'; END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'event not in tenant' USING ERRCODE='22023'; END IF;
 r:=NULLIF(p_command->>'requirementId','')::uuid;
 IF r IS NULL THEN
 INSERT INTO public.sales_space_requirement(tenant_id,name) VALUES(p_tenant,btrim(p_command->>'requirementName')) RETURNING id INTO r;
 END IF;
 INSERT INTO public.sales_space_group(tenant_id,requirement_id,event_id,event_kind,name,prefix,currency)
 VALUES(p_tenant,r,(p_command->>'eventId')::uuid,p_command->>'eventKind',btrim(p_command->>'name'),upper(btrim(p_command->>'prefix')),p_command->>'currency') RETURNING * INTO g;
 END IF;
 FOR i IN g.next_ordinal..g.next_ordinal+n-1 LOOP
 INSERT INTO public.sales_exhibition_space(tenant_id,group_id,event_id,event_kind,reference,price_minor)
 VALUES(p_tenant,g.id,g.event_id,g.event_kind,g.prefix||'-'||i,price);
 END LOOP;
 UPDATE public.sales_space_group SET next_ordinal=next_ordinal+n WHERE id=g.id;
 result:=jsonb_build_object('groupId',g.id,'added',n);
 INSERT INTO public.sales_space_command VALUES(p_tenant,key,p_command,result);
 RETURN result;
 ELSIF p_command->>'action'='edit' THEN
 SELECT * INTO s FROM public.sales_exhibition_space WHERE tenant_id=p_tenant AND id=(p_command->>'id')::uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'space not found' USING ERRCODE='P0002'; END IF;
 IF (p_command ? 'blocked' OR p_command ? 'archived') AND EXISTS(SELECT 1 FROM public.sales_space_allocation WHERE tenant_id=p_tenant AND space_id=s.id AND state IN ('reserved','sold')) THEN
 RAISE EXCEPTION 'Reserved or sold spaces cannot be blocked or archived' USING ERRCODE='40001'; END IF;
 UPDATE public.sales_exhibition_space SET
 price_minor=CASE WHEN p_command ? 'priceMinor' THEN (p_command->>'priceMinor')::bigint ELSE price_minor END,
 blocked=CASE WHEN p_command ? 'blocked' THEN (p_command->>'blocked')::boolean ELSE blocked END,
 archived=CASE WHEN p_command ? 'archived' THEN (p_command->>'archived')::boolean ELSE archived END
 WHERE id=s.id RETURNING * INTO s;
 RETURN to_jsonb(s);
 END IF;
 RAISE EXCEPTION 'unknown exhibition command' USING ERRCODE='22023';
END $$;

-- Read-only projection: no public grants; query readers still scope by tenant.
CREATE VIEW public.sales_exhibition_overview WITH(security_invoker=true) AS
 SELECT s.*,g.name group_name,g.requirement_id,g.currency,
 COALESCE(e.title,ce.title,'Event') event_name,
 CASE WHEN a.state IS NOT NULL THEN a.state WHEN s.blocked OR s.archived THEN 'unavailable' ELSE 'available' END status,
 a.quote_id,q.quote_number,COALESCE(v.organisation_snapshot->>'name',v.customer_contact_snapshot->>'name','') customer_name
 FROM public.sales_exhibition_space s JOIN public.sales_space_group g ON g.tenant_id=s.tenant_id AND g.id=s.group_id
 LEFT JOIN public.sales_space_allocation a ON a.tenant_id=s.tenant_id AND a.space_id=s.id AND a.state IN ('reserved','sold')
 LEFT JOIN public.sales_quote q ON q.tenant_id=a.tenant_id AND q.id=a.quote_id
 LEFT JOIN public.sales_quote_version v ON v.tenant_id=q.tenant_id AND v.quote_id=q.id AND v.version_number=q.current_version
 LEFT JOIN public.event e ON s.event_kind='simple' AND e.tenant_id=s.tenant_id AND e.id=s.event_id
 LEFT JOIN public.complex_event ce ON s.event_kind='complex' AND ce.tenant_id=s.tenant_id AND ce.id=s.event_id;
REVOKE ALL ON public.sales_exhibition_overview FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.sales_exhibition_overview TO service_role;

CREATE FUNCTION public.guard_sales_space_allocation() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.state IN ('sold','released') OR
 (to_jsonb(NEW)-'state'-'released_at'-'sold_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'released_at'-'sold_at')
 OR NEW.state NOT IN ('sold','released') THEN
 RAISE EXCEPTION 'Allocation evidence is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_space_allocation_evidence BEFORE UPDATE OR DELETE ON public.sales_space_allocation
 FOR EACH ROW EXECUTE FUNCTION public.guard_sales_space_allocation();

-- Reserve/sync is invoked inside the quote-save transaction, after the line
-- rewrite. Quote-root ownership survives line IDs and version amendments.
CREATE FUNCTION public.sync_sales_exhibition(p_tenant uuid,p_quote uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.sales_quote%ROWTYPE; v public.sales_quote_version%ROWTYPE; l record; slot jsonb; pick jsonb;
 s public.sales_exhibition_space%ROWTYPE; g public.sales_space_group%ROWTYPE; a public.sales_space_allocation%ROWTYPE;
 expected integer; actual integer; keys text[]:='{}'; ids uuid[]:='{}'; selected text[]:='{}';
BEGIN
 PERFORM public.sales_space_lock(p_tenant);
 SELECT * INTO q FROM public.sales_quote WHERE tenant_id=p_tenant AND id=p_quote FOR UPDATE;
 SELECT * INTO v FROM public.sales_quote_version WHERE tenant_id=p_tenant AND quote_id=p_quote AND version_number=q.current_version FOR UPDATE;
 IF v.status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'only drafts reserve spaces' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.sales_space_allocation WHERE tenant_id=p_tenant AND quote_id=p_quote AND state='sold') THEN
 RAISE EXCEPTION 'Sold inventory requires the financial amendment process' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.sales_space_allocation WHERE tenant_id=p_tenant AND quote_id=p_quote AND state='reserved'
 AND (event_id::text IS DISTINCT FROM v.event_snapshot->>'id' OR event_kind IS DISTINCT FROM v.event_snapshot->>'kind')) THEN
 RAISE EXCEPTION 'Release exhibition selections before changing the proposal Event' USING ERRCODE='23514'; END IF;
 FOR l IN SELECT * FROM public.sales_quote_line WHERE tenant_id=p_tenant AND quote_version_id=v.id ORDER BY display_order LOOP
 SELECT COALESCE(sum(units),0)::integer INTO expected FROM (
 SELECT l.quantity units FROM public.sales_catalogue_product p WHERE p.tenant_id=p_tenant AND p.id=l.product_id AND p.space_requirement_id IS NOT NULL
 UNION ALL SELECT l.quantity*c.quantity FROM public.sales_quote_bundle_component c
 JOIN public.sales_catalogue_product p ON p.tenant_id=c.tenant_id AND p.id=c.product_id
 WHERE c.tenant_id=p_tenant AND c.quote_line_id=l.id AND p.space_requirement_id IS NOT NULL) x;
 IF expected<0 OR expected>1000 THEN RAISE EXCEPTION 'invalid exhibition quantity' USING ERRCODE='23514'; END IF;
 actual:=jsonb_array_length(COALESCE(l.catalogue_snapshot->'exhibition'->'slots','[]'));
 IF actual<>expected THEN RAISE EXCEPTION 'Exhibition requirements changed; reload catalogue and save' USING ERRCODE='40001'; END IF;
 FOR slot IN SELECT value FROM jsonb_array_elements(COALESCE(l.catalogue_snapshot->'exhibition'->'slots','[]')) LOOP
 IF slot->>'key'=ANY(keys) OR slot->>'key' IS NULL THEN RAISE EXCEPTION 'duplicate exhibition slot' USING ERRCODE='23514'; END IF;
 keys:=array_append(keys,slot->>'key');
 END LOOP;
 FOR pick IN SELECT value FROM jsonb_array_elements(COALESCE(l.catalogue_snapshot->'exhibition'->'selections','[]')) LOOP
 SELECT value INTO slot FROM jsonb_array_elements(l.catalogue_snapshot->'exhibition'->'slots') WHERE value->>'key'=pick->>'slotKey';
 IF slot IS NULL OR pick->>'slotKey'=ANY(selected) OR (pick->>'spaceId')::uuid=ANY(ids) THEN RAISE EXCEPTION 'invalid or duplicate selection' USING ERRCODE='23514'; END IF;
 ids:=array_append(ids,(pick->>'spaceId')::uuid); selected:=array_append(selected,pick->>'slotKey');
 SELECT * INTO s FROM public.sales_exhibition_space WHERE tenant_id=p_tenant AND id=(pick->>'spaceId')::uuid FOR UPDATE;
 IF NOT FOUND OR s.blocked OR s.archived THEN RAISE EXCEPTION 'Space is unavailable' USING ERRCODE='40001'; END IF;
 SELECT * INTO g FROM public.sales_space_group WHERE tenant_id=p_tenant AND id=s.group_id;
 IF g.requirement_id::text IS DISTINCT FROM slot->>'requirementId' OR g.currency<>v.currency
 OR s.event_id::text IS DISTINCT FROM v.event_snapshot->>'id' OR s.event_kind IS DISTINCT FROM v.event_snapshot->>'kind' THEN
 RAISE EXCEPTION 'Space does not match proposal Event, group or currency' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM public.sales_space_allocation WHERE tenant_id=p_tenant AND space_id=s.id AND state IN ('reserved','sold');
 IF FOUND AND (a.quote_id<>p_quote OR a.slot_key<>pick->>'slotKey' OR a.state='sold') THEN
 RAISE EXCEPTION 'Space has been reserved or sold by another selection' USING ERRCODE='40001'; END IF;
 IF pick->>'reference' IS DISTINCT FROM s.reference OR pick->>'currency' IS DISTINCT FROM g.currency OR
 (pick->>'priceMinor')::bigint IS DISTINCT FROM COALESCE(a.price_minor,s.price_minor) THEN
 RAISE EXCEPTION 'Space price changed; reload and retry' USING ERRCODE='40001'; END IF;
 END LOOP;
 END LOOP;
 IF cardinality(keys)>1000 THEN RAISE EXCEPTION 'Too many exhibition units' USING ERRCODE='23514'; END IF;
 -- Only release after the entire desired set has passed validation.
 UPDATE public.sales_space_allocation SET state='released',released_at=now() WHERE tenant_id=p_tenant AND quote_id=p_quote AND state='reserved'
 AND NOT (slot_key=ANY(selected) AND space_id=ANY(ids));
 -- Replacements at the same slot need the old space released before inserting.
 UPDATE public.sales_space_allocation alloc SET state='released',released_at=now()
 WHERE alloc.tenant_id=p_tenant AND alloc.quote_id=p_quote AND alloc.state='reserved' AND NOT EXISTS(
 SELECT 1 FROM public.sales_quote_line ln CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ln.catalogue_snapshot->'exhibition'->'selections','[]')) p
 WHERE ln.tenant_id=p_tenant AND ln.quote_version_id=v.id AND p->>'slotKey'=alloc.slot_key AND (p->>'spaceId')::uuid=alloc.space_id);
 INSERT INTO public.sales_space_allocation(tenant_id,space_id,quote_id,slot_key,state,reference,price_minor,currency,event_id,event_kind)
 SELECT p_tenant,(p->>'spaceId')::uuid,p_quote,p->>'slotKey','reserved',p->>'reference',(p->>'priceMinor')::bigint,p->>'currency',
 (v.event_snapshot->>'id')::uuid,v.event_snapshot->>'kind'
 FROM public.sales_quote_line ln CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ln.catalogue_snapshot->'exhibition'->'selections','[]')) p
 WHERE ln.tenant_id=p_tenant AND ln.quote_version_id=v.id AND NOT EXISTS(
 SELECT 1 FROM public.sales_space_allocation alloc WHERE alloc.tenant_id=p_tenant AND alloc.quote_id=p_quote AND alloc.slot_key=p->>'slotKey' AND alloc.space_id=(p->>'spaceId')::uuid AND alloc.state='reserved');
END $$;

ALTER FUNCTION public.save_sales_quote_draft(uuid,uuid,integer,jsonb,text,text) RENAME TO save_sales_quote_draft_before_exhibition;
REVOKE ALL ON FUNCTION public.save_sales_quote_draft_before_exhibition(uuid,uuid,integer,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.save_sales_quote_draft(p_tenant_id uuid,p_quote_id uuid,p_expected_version integer,p_payload jsonb,p_actor_id text,p_actor_type text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM public.sales_space_lock(p_tenant_id);
 result:=public.save_sales_quote_draft_before_exhibition(p_tenant_id,p_quote_id,p_expected_version,p_payload,p_actor_id,p_actor_type);
 PERFORM public.sync_sales_exhibition(p_tenant_id,(result->>'id')::uuid);
 RETURN result;
END $$;

CREATE FUNCTION public.guard_sales_exhibition_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE expected integer; actual integer;
BEGIN
 IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 PERFORM public.sales_space_lock(NEW.tenant_id);
 IF NEW.status='superseded' AND EXISTS(SELECT 1 FROM public.sales_space_allocation WHERE tenant_id=NEW.tenant_id AND quote_id=NEW.quote_id AND state='sold') THEN
 RAISE EXCEPTION 'Sold exhibition inventory requires financial amendment safeguards' USING ERRCODE='23514'; END IF;
 IF NEW.status IN ('issued','accepted','converted') THEN
 SELECT COALESCE(sum(jsonb_array_length(COALESCE(catalogue_snapshot->'exhibition'->'slots','[]'))),0) INTO expected
 FROM public.sales_quote_line WHERE tenant_id=NEW.tenant_id AND quote_version_id=NEW.id;
 SELECT count(*) INTO actual FROM public.sales_space_allocation WHERE tenant_id=NEW.tenant_id AND quote_id=NEW.quote_id AND state IN ('reserved','sold');
 IF expected<>actual THEN RAISE EXCEPTION 'Select an available space for every exhibition unit before issuing or accepting' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.sales_quote_line ln CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ln.catalogue_snapshot->'exhibition'->'slots','[]')) slot
 WHERE ln.tenant_id=NEW.tenant_id AND ln.quote_version_id=NEW.id AND NOT EXISTS(
 SELECT 1 FROM public.sales_space_allocation alloc WHERE alloc.tenant_id=NEW.tenant_id AND alloc.quote_id=NEW.quote_id AND alloc.slot_key=slot->>'key' AND alloc.state IN ('reserved','sold')
 AND alloc.event_id::text=NEW.event_snapshot->>'id' AND alloc.event_kind=NEW.event_snapshot->>'kind')) THEN
 RAISE EXCEPTION 'Exhibition ownership changed; revalidate selections' USING ERRCODE='40001'; END IF;
 IF NEW.status IN ('accepted','converted') THEN
 UPDATE public.sales_space_allocation SET state='sold',sold_at=now() WHERE tenant_id=NEW.tenant_id AND quote_id=NEW.quote_id AND state='reserved';
 END IF;
 ELSIF NEW.status IN ('declined','expired') THEN
 UPDATE public.sales_space_allocation SET state='released',released_at=now() WHERE tenant_id=NEW.tenant_id AND quote_id=NEW.quote_id AND state='reserved';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_exhibition_lifecycle BEFORE UPDATE OF status ON public.sales_quote_version FOR EACH ROW EXECUTE FUNCTION public.guard_sales_exhibition_lifecycle();

CREATE FUNCTION public.sales_exhibition_opportunity_lost() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.stage_id IS DISTINCT FROM OLD.stage_id AND EXISTS(SELECT 1 FROM public.opportunity_stage WHERE tenant_id=NEW.tenant_id AND id=NEW.stage_id AND is_lost) THEN
 PERFORM public.sales_space_lock(NEW.tenant_id);
 UPDATE public.sales_space_allocation a SET state='released',released_at=now() FROM public.sales_quote q
 WHERE a.tenant_id=NEW.tenant_id AND a.quote_id=q.id AND q.tenant_id=NEW.tenant_id AND q.opportunity_id=NEW.id AND a.state='reserved';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_exhibition_opportunity_lost AFTER UPDATE OF stage_id ON public.opportunity FOR EACH ROW EXECUTE FUNCTION public.sales_exhibition_opportunity_lost();

CREATE FUNCTION public.sales_exhibition_terminal(p_tenant uuid,p_quote uuid,p_version integer,p_action text,p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.sales_quote%ROWTYPE; v public.sales_quote_version%ROWTYPE; result jsonb;
BEGIN
 PERFORM public.sales_space_lock(p_tenant);
 SELECT * INTO q FROM public.sales_quote WHERE tenant_id=p_tenant AND id=p_quote FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'quote not found' USING ERRCODE='P0002'; END IF;
 IF q.row_version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'quote changed; reload' USING ERRCODE='40001'; END IF;
 SELECT * INTO v FROM public.sales_quote_version WHERE tenant_id=p_tenant AND quote_id=q.id AND version_number=q.current_version FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.sales_commercial_sale WHERE tenant_id=p_tenant AND quote_id=p_quote)
 OR EXISTS(SELECT 1 FROM public.sales_space_allocation WHERE tenant_id=p_tenant AND quote_id=p_quote AND state='sold')
 OR v.status IN ('accepted','converted') THEN RAISE EXCEPTION 'Accepted sales require financial safeguards' USING ERRCODE='23514'; END IF;
 IF p_action IN ('cancel','delete') THEN
 UPDATE public.sales_quote_version SET status='declined',updated_at=now() WHERE id=v.id;
 UPDATE public.sales_quote SET row_version=row_version+1,updated_at=now(),updated_by=p_actor WHERE id=q.id;
 IF p_action='delete' THEN
 UPDATE public.sales_quote SET exhibition_deleted_at=now() WHERE id=q.id;
 UPDATE public.sales_quote_delivery_token SET revoked_at=now(),revoked_by=p_actor WHERE tenant_id=p_tenant AND quote_id=q.id AND revoked_at IS NULL;
 END IF;
 INSERT INTO public.sales_quote_status_history(tenant_id,quote_id,quote_version_id,from_status,to_status,actor_id,actor_type,note)
 VALUES(p_tenant,q.id,v.id,v.status,'declined',p_actor,'system','Cancelled by staff; unsold exhibition reservations released');
 ELSIF p_action='reopen' THEN
 IF v.status NOT IN ('declined','expired') THEN RAISE EXCEPTION 'Only declined or expired proposals can reopen; amend issued proposals' USING ERRCODE='23514'; END IF;
 result:=public.amend_sales_quote(p_tenant,p_quote,p_version,p_actor,'system');
 UPDATE public.sales_quote_line SET catalogue_snapshot=jsonb_set(catalogue_snapshot,'{exhibition,selections}','[]')
 WHERE tenant_id=p_tenant AND quote_version_id=(SELECT id FROM public.sales_quote_version WHERE tenant_id=p_tenant AND quote_id=p_quote AND version_number=(result->>'current_version')::integer)
 AND catalogue_snapshot ? 'exhibition';
 ELSE RAISE EXCEPTION 'unknown action' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('id',q.id,'action',p_action);
END $$;

-- Any accepted inventory is tied to the same sale boundary as ticket/billing
-- acceptance. Patch only known clauses and fail closed on unexpected versions.
DO $migration$
DECLARE definition text; anchor text;
BEGIN
 SELECT pg_get_functiondef('public.transition_sales_quote(uuid,uuid,integer,text,text,text,text)'::regprocedure) INTO definition;
 anchor:='IF p_status=''accepted'' AND (v.billing_schedule IS NOT NULL OR EXISTS(';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unknown staff acceptance function'; END IF;
 EXECUTE replace(definition,anchor,'IF p_status=''accepted'' AND (EXISTS(SELECT 1 FROM public.sales_space_allocation WHERE tenant_id=p_tenant_id AND quote_id=p_quote_id AND state IN (''reserved'',''sold'')) OR v.billing_schedule IS NOT NULL OR EXISTS(');
 -- New products must persist their independent space requirement through the
 -- existing atomic catalogue creation path.
 SELECT pg_get_functiondef('public.create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text)'::regprocedure) INTO definition;
 anchor:='ticket_type_id, create_task_on_acceptance, created_by, updated_by';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unknown catalogue creation function'; END IF;
 definition:=replace(definition,anchor,'ticket_type_id, create_task_on_acceptance, created_by, updated_by, space_requirement_id');
 anchor:='COALESCE(v_product.create_task_on_acceptance, false), p_actor_id, p_actor_id';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unknown catalogue creation values'; END IF;
 EXECUTE replace(definition,anchor,anchor||', v_product.space_requirement_id');
END $migration$;

CREATE FUNCTION public.set_sales_product_space_requirement(p_tenant uuid,p_product uuid,p_requirement uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.sales_space_lock(p_tenant);
 UPDATE public.sales_catalogue_product SET space_requirement_id=p_requirement WHERE tenant_id=p_tenant AND id=p_product;
 IF NOT FOUND THEN RAISE EXCEPTION 'product not found' USING ERRCODE='P0002'; END IF;
END $$;

CREATE FUNCTION public.guard_exhibition_catalogue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.space_requirement_id IS DISTINCT FROM NEW.space_requirement_id THEN
 PERFORM public.sales_space_lock(OLD.tenant_id);
 IF EXISTS(SELECT 1 FROM public.sales_quote_line l JOIN public.sales_quote_version v ON v.tenant_id=l.tenant_id AND v.id=l.quote_version_id
 JOIN public.sales_quote q ON q.tenant_id=v.tenant_id AND q.id=v.quote_id AND q.current_version=v.version_number
 WHERE l.tenant_id=OLD.tenant_id AND (l.product_id=OLD.id OR EXISTS(SELECT 1 FROM public.sales_quote_bundle_component c WHERE c.tenant_id=OLD.tenant_id AND c.quote_line_id=l.id AND c.product_id=OLD.id))
 AND v.status NOT IN ('declined','expired','superseded')) THEN
 RAISE EXCEPTION 'Product is used by an active proposal; create a new product to change its space requirement' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_exhibition_product_guard BEFORE UPDATE ON public.sales_catalogue_product FOR EACH ROW EXECUTE FUNCTION public.guard_exhibition_catalogue();

CREATE FUNCTION public.guard_exhibition_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
 IF EXISTS(SELECT 1 FROM public.sales_space_group WHERE tenant_id=OLD.tenant_id AND event_id=OLD.id
 AND event_kind=CASE WHEN TG_TABLE_NAME='event' THEN 'simple' ELSE 'complex' END) THEN
 RAISE EXCEPTION 'Event has exhibition inventory and cannot be deleted or reassigned' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_exhibition_event_guard BEFORE UPDATE OR DELETE ON public.event FOR EACH ROW EXECUTE FUNCTION public.guard_exhibition_event();
CREATE TRIGGER sales_exhibition_complex_event_guard BEFORE UPDATE OR DELETE ON public.complex_event FOR EACH ROW EXECUTE FUNCTION public.guard_exhibition_event();

-- No exposed helper mutation RPCs: public entrypoints only.
REVOKE ALL ON FUNCTION public.sales_space_lock(uuid),public.sync_sales_exhibition(uuid,uuid),
 public.manage_sales_exhibition(uuid,jsonb),public.sales_exhibition_terminal(uuid,uuid,integer,text,text),
 public.save_sales_quote_draft(uuid,uuid,integer,jsonb,text,text),public.set_sales_product_space_requirement(uuid,uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.manage_sales_exhibition(uuid,jsonb),public.sales_exhibition_terminal(uuid,uuid,integer,text,text),
 public.save_sales_quote_draft(uuid,uuid,integer,jsonb,text,text),public.set_sales_product_space_requirement(uuid,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';

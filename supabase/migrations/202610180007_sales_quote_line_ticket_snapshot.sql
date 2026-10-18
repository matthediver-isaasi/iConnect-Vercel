-- Proposal-local ticket identities and delegate multipliers are immutable
-- version data. Never infer allocations from header metadata or live products.
BEGIN;
DO $migration$
DECLARE definition text; updated text; old_block text; new_block text;
BEGIN
 SELECT pg_get_functiondef('public.confirm_sales_quote_ticket_sale(uuid,uuid,integer,text,text,uuid)'::regprocedure) INTO definition;
 old_block := $old$ SELECT l.id quote_line_id,NULL::uuid component_id,p.event_reference_kind,p.event_id,p.ticket_type_id,
   l.quantity quantity,1 component_quantity,l.catalogue_snapshot ticket_snapshot
 FROM public.sales_quote_line l JOIN public.sales_catalogue_product p
   ON p.tenant_id=l.tenant_id AND p.id=l.product_id
 WHERE l.tenant_id=p_tenant_id AND l.quote_version_id=v.id AND p.event_id IS NOT NULL
 UNION ALL
 SELECT l.id,c.id,p.event_reference_kind,p.event_id,p.ticket_type_id,
   l.quantity,c.quantity,c.product_snapshot
 FROM public.sales_quote_line l JOIN public.sales_quote_bundle_component c
   ON c.tenant_id=l.tenant_id AND c.quote_line_id=l.id
 JOIN public.sales_catalogue_product p ON p.tenant_id=c.tenant_id AND p.id=c.product_id
 WHERE l.tenant_id=p_tenant_id AND l.quote_version_id=v.id AND p.event_id IS NOT NULL;$old$;
 new_block := $new$ SELECT l.id quote_line_id,NULL::uuid component_id,
   l.catalogue_snapshot->>'event_reference_kind' event_reference_kind,
   (l.catalogue_snapshot->>'event_id')::uuid event_id,l.catalogue_snapshot->>'ticket_type_id' ticket_type_id,
   l.quantity quantity,1 component_quantity,l.catalogue_snapshot ticket_snapshot
 FROM public.sales_quote_line l
 WHERE l.tenant_id=p_tenant_id AND l.quote_version_id=v.id AND l.product_id IS NOT NULL
   AND l.catalogue_snapshot->>'event_id' IS NOT NULL
 UNION ALL
 SELECT l.id,c.id,c.product_snapshot->>'event_reference_kind',
   (c.product_snapshot->>'event_id')::uuid,c.product_snapshot->>'ticket_type_id',
   l.quantity,c.quantity,c.product_snapshot
 FROM public.sales_quote_line l JOIN public.sales_quote_bundle_component c
   ON c.tenant_id=l.tenant_id AND c.quote_line_id=l.id
 WHERE l.tenant_id=p_tenant_id AND l.quote_version_id=v.id
   AND c.product_snapshot->>'event_id' IS NOT NULL;$new$;
 updated := replace(definition,old_block,new_block);
 IF updated=definition THEN RAISE EXCEPTION 'ticket snapshot candidate patch did not match'; END IF;
 definition := updated;
 -- Retain live tenant/existence checks, but never use today's group size.
 old_block := $old$   places:=candidate.quantity*candidate.component_quantity*multiplier;$old$;
 new_block := $new$   multiplier := (candidate.ticket_snapshot->'capacity_metadata'->>'delegate_capacity')::integer;
   IF multiplier IS NULL OR multiplier<=0 THEN
     RAISE EXCEPTION 'ticket snapshot has no frozen delegate capacity; amend this proposal before acceptance' USING ERRCODE='22023';
   END IF;
   places:=candidate.quantity*candidate.component_quantity*multiplier;$new$;
 updated := replace(definition,old_block,new_block);
 IF updated=definition THEN RAISE EXCEPTION 'ticket snapshot multiplier patch did not match'; END IF;
 definition := updated;
 old_block := $old$COALESCE(v.event_snapshot,'{}'::jsonb),COALESCE(candidate.ticket_snapshot,'{}'::jsonb)$old$;
 new_block := $new$jsonb_build_object('id',candidate.event_id,'kind',candidate.event_reference_kind),COALESCE(candidate.ticket_snapshot,'{}'::jsonb)$new$;
 updated := replace(definition,old_block,new_block);
 IF updated=definition THEN RAISE EXCEPTION 'ticket snapshot event patch did not match'; END IF;
 definition := updated;
 old_block := $old$sum(quantity*component_quantity*
   CASE WHEN event_reference_kind='complex' THEN
     COALESCE((SELECT CASE WHEN t.is_group_ticket THEN t.group_size ELSE 1 END
       FROM public.complex_event_ticket_class t WHERE t.complex_event_id=c.event_id AND t.id::text=c.ticket_type_id),1)
   ELSE 1 END)::integer requested$old$;
 new_block := $new$sum(quantity*component_quantity*
   (ticket_snapshot->'capacity_metadata'->>'delegate_capacity')::integer)::integer requested$new$;
 updated := replace(definition,old_block,new_block);
 IF updated=definition THEN RAISE EXCEPTION 'ticket snapshot totals patch did not match'; END IF;
 EXECUTE updated;

 SELECT pg_get_functiondef('public.confirm_sales_quote_sale(uuid,uuid,integer,text,text,uuid)'::regprocedure) INTO definition;
 updated := replace(definition,
   '(p.event_id IS NOT NULL OR cp.event_id IS NOT NULL)',
   '(l.catalogue_snapshot->>''event_id'' IS NOT NULL OR c.product_snapshot->>''event_id'' IS NOT NULL)');
 IF updated=definition THEN RAISE EXCEPTION 'ticket snapshot routing patch did not match'; END IF;
 EXECUTE updated;
END $migration$;
COMMIT;

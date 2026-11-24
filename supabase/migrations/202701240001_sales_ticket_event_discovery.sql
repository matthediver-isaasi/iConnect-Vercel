-- Authoring only. No allocation backfill and no changes to public event visibility.
BEGIN;

-- Legacy event tables can store dates as text. A date-only or malformed value
-- is not a known start instant; never let the database session timezone guess it.
CREATE FUNCTION public.sales_ticket_known_instant(value text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp
AS $function$
BEGIN
  IF value IS NULL OR value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$' THEN
    RETURN NULL;
  END IF;
  RETURN value::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.sales_ticket_known_instant(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sales_ticket_known_instant(text) TO service_role;

-- Keep date and waiting-list semantics in the database so browser clocks cannot
-- widen the selectable set. Draft status is deliberately not excluded.
CREATE FUNCTION public.sales_ticket_event_options(
  p_tenant uuid, p_search text DEFAULT '', p_page integer DEFAULT 1,
  p_selected uuid DEFAULT NULL, p_kind text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE result jsonb;
BEGIN
  IF p_tenant IS NULL OR p_page IS NULL OR p_page NOT BETWEEN 1 AND 10000
    OR length(COALESCE(p_search,'')) > 150
    OR (p_selected IS NOT NULL AND (p_kind IS NULL OR p_kind NOT IN ('simple','complex'))) THEN
    RAISE EXCEPTION 'Invalid ticket event search' USING ERRCODE='22023';
  END IF;
  WITH events AS (
    SELECT e.id, e.title,
      public.sales_ticket_known_instant(to_jsonb(e)->>'start_date') start_date,
      public.sales_ticket_known_instant(to_jsonb(e)->>'end_date') end_date, 'simple'::text kind,
      e.waiting_list_enabled,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', t->>'id', 'name', COALESCE(NULLIF(t->>'name',''),'Unnamed ticket'),
        'isGroupTicket', t->'is_group_ticket' = 'true'::jsonb,
        'groupSize', CASE WHEN t->'is_group_ticket' = 'true'::jsonb THEN t->'group_size' END,
        'delegateCapacity', CASE WHEN t->'is_group_ticket' = 'true'::jsonb
          AND COALESCE(t->>'group_size','') ~ '^[1-9][0-9]{0,8}$'
          THEN (t->>'group_size')::integer ELSE 1 END
      ) ORDER BY ordinal)
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.pricing_config->'ticket_classes')='array'
        THEN e.pricing_config->'ticket_classes' ELSE '[]'::jsonb END)
        WITH ORDINALITY tickets(t,ordinal)
      WHERE NULLIF(t->>'id','') IS NOT NULL), '[]'::jsonb) tickets
    FROM public.event e WHERE e.tenant_id=p_tenant
      AND (p_selected IS NULL OR (p_kind='simple' AND e.id=p_selected))
    UNION ALL
    SELECT e.id, e.title,
      public.sales_ticket_known_instant(to_jsonb(e)->>'start_date'),
      public.sales_ticket_known_instant(to_jsonb(e)->>'end_date'), 'complex'::text,
      e.waiting_list_enabled,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', COALESCE(NULLIF(t.name,''),'Unnamed ticket'),
        'isGroupTicket', t.is_group_ticket IS TRUE,
        'groupSize', CASE WHEN t.is_group_ticket THEN t.group_size END,
        'delegateCapacity', CASE WHEN t.is_group_ticket AND t.group_size>0 THEN t.group_size ELSE 1 END
      ) ORDER BY lower(COALESCE(t.name,'')) COLLATE "C", t.id)
      FROM public.complex_event_ticket_class t
      WHERE t.tenant_id=p_tenant AND t.complex_event_id=e.id), '[]'::jsonb)
    FROM public.complex_event e WHERE e.tenant_id=p_tenant
      AND (p_selected IS NULL OR (p_kind='complex' AND e.id=p_selected))
  ), classified AS (
    SELECT *, CASE
      WHEN waiting_list_enabled IS TRUE THEN 'This event is in waiting-list mode.'
      WHEN start_date IS NULL THEN 'This event does not have a start date and time.'
      WHEN start_date <= statement_timestamp() THEN 'This event has already started.'
      WHEN jsonb_array_length(tickets)=0 THEN 'This event has no ticket types.'
      ELSE NULL END reason
    FROM events
  ), page_rows AS (
    SELECT *, row_number() OVER (ORDER BY lower(COALESCE(title,'')) COLLATE "C", kind, id) position
    FROM classified
    WHERE p_selected IS NOT NULL OR
      (reason IS NULL AND strpos(lower(COALESCE(title,'')),lower(COALESCE(p_search,'')))>0)
  ), bounded AS (
    SELECT * FROM page_rows
    WHERE p_selected IS NOT NULL OR position BETWEEN (p_page-1)*25+1 AND p_page*25+1
  )
  SELECT jsonb_build_object(
    'items', COALESCE(jsonb_agg(jsonb_build_object(
      'id', id, 'name', title, 'kind', kind, 'startDate', start_date, 'endDate', end_date,
      'eligible', reason IS NULL, 'unavailableReason', reason, 'ticketOptions', tickets
    ) ORDER BY position) FILTER (WHERE p_selected IS NOT NULL OR position<=p_page*25), '[]'::jsonb),
    'hasMore', COALESCE(bool_or(p_selected IS NULL AND position>p_page*25), false),
    'page', p_page
  ) INTO result FROM bounded;
  RETURN result;
END $function$;

REVOKE ALL ON FUNCTION public.sales_ticket_event_options(uuid,text,integer,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sales_ticket_event_options(uuid,text,integer,uuid,text) TO service_role;
COMMIT;

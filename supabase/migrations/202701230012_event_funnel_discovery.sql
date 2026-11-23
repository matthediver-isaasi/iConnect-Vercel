BEGIN;
-- Computed fields filter in PostgreSQL BEFORE list limits/counts/pagination.
-- Unlisted is not draft, private, or ineligible for direct registration.
CREATE FUNCTION public.event_funnel_discoverable(e public.event)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT NOT EXISTS(
    SELECT 1 FROM public.event_funnel_offer_policy p
      JOIN public.event_funnel_entry x ON x.tenant_id=p.tenant_id AND x.version_id=p.version_id
      WHERE p.tenant_id=e.tenant_id AND p.event_kind='simple' AND p.event_id=e.id AND p.unlisted
  )
$$;
CREATE FUNCTION public.event_funnel_discoverable(e public.complex_event)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT NOT EXISTS(
    SELECT 1 FROM public.event_funnel_offer_policy p
      JOIN public.event_funnel_entry x ON x.tenant_id=p.tenant_id AND x.version_id=p.version_id
      WHERE p.tenant_id=e.tenant_id AND p.event_kind='complex' AND p.event_id=e.id AND p.unlisted
  )
$$;
CREATE FUNCTION public.event_funnel_discovery_ready()
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.event_funnel_discoverable(public.event),public.event_funnel_discoverable(public.complex_event),
  public.event_funnel_discovery_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_discoverable(public.event),public.event_funnel_discoverable(public.complex_event),
  public.event_funnel_discovery_ready() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

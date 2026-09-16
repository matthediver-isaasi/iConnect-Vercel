-- Task #4426: tenant-scoped unique event-card click tracking.
--
-- Raw browser UUIDs never reach this schema. The API stores only a
-- server-derived HMAC digest, and these tables are inaccessible through
-- PostgREST to prevent visitor-level analytics disclosure.

CREATE TABLE IF NOT EXISTS public.event_card_click (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.event(id) ON DELETE CASCADE,
  visitor_key_hash BYTEA NOT NULL CHECK (octet_length(visitor_key_hash) = 32),
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_id, visitor_key_hash)
);

CREATE TABLE IF NOT EXISTS public.complex_event_card_click (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.complex_event(id) ON DELETE CASCADE,
  visitor_key_hash BYTEA NOT NULL CHECK (octet_length(visitor_key_hash) = 32),
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_id, visitor_key_hash)
);

CREATE INDEX IF NOT EXISTS idx_event_card_click_tenant_event
  ON public.event_card_click (tenant_id, event_id);
CREATE INDEX IF NOT EXISTS idx_complex_event_card_click_tenant_event
  ON public.complex_event_card_click (tenant_id, event_id);

COMMENT ON TABLE public.event_card_click IS
  'Unique /events card activations for simple events; visitor_key_hash is an API-derived opaque HMAC.';
COMMENT ON TABLE public.complex_event_card_click IS
  'Unique /events card activations for complex events; visitor_key_hash is an API-derived opaque HMAC.';

ALTER TABLE public.event_card_click ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_card_click FORCE ROW LEVEL SECURITY;
ALTER TABLE public.complex_event_card_click ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complex_event_card_click FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.event_card_click FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.complex_event_card_click FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.event_card_click TO service_role;
GRANT ALL ON TABLE public.complex_event_card_click TO service_role;

CREATE OR REPLACE FUNCTION public.record_event_card_click(
  p_tenant_id UUID,
  p_event_id UUID,
  p_event_type TEXT,
  p_visitor_key_hash TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hash BYTEA;
  v_inserted BOOLEAN := FALSE;
BEGIN
  IF p_tenant_id IS NULL
     OR p_event_id IS NULL
     OR p_event_type NOT IN ('simple', 'complex')
     OR p_visitor_key_hash IS NULL
     OR p_visitor_key_hash !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'invalid event click payload' USING ERRCODE = '22023';
  END IF;

  v_hash := decode(lower(p_visitor_key_hash), 'hex');

  IF p_event_type = 'simple' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.event
       WHERE id = p_event_id
         AND tenant_id = p_tenant_id
         AND status IN ('published', 'tbc', 'immediate')
         AND COALESCE(event_state, 'active') <> 'draft'
         AND (
           member_group_id IS NULL
           OR CASE
             WHEN jsonb_typeof(pricing_config->'ticket_classes') = 'array'
               THEN jsonb_array_length(pricing_config->'ticket_classes') > 0
             ELSE FALSE
           END
         )
    ) THEN
      RAISE EXCEPTION 'event is not tenant-owned' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.event_card_click (tenant_id, event_id, visitor_key_hash)
    VALUES (p_tenant_id, p_event_id, v_hash)
    ON CONFLICT (tenant_id, event_id, visitor_key_hash) DO NOTHING;
    v_inserted := FOUND;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.complex_event
       WHERE id = p_event_id
         AND tenant_id = p_tenant_id
         AND status IN ('published', 'tbc')
         AND (event_state IS NULL OR event_state IN ('active', 'closed'))
    ) THEN
      RAISE EXCEPTION 'complex event is not tenant-owned' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.complex_event_card_click (tenant_id, event_id, visitor_key_hash)
    VALUES (p_tenant_id, p_event_id, v_hash)
    ON CONFLICT (tenant_id, event_id, visitor_key_hash) DO NOTHING;
    v_inserted := FOUND;
  END IF;

  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_event_card_click_counts(
  p_tenant_id UUID,
  p_simple_event_ids UUID[] DEFAULT '{}'::UUID[],
  p_complex_event_ids UUID[] DEFAULT '{}'::UUID[]
) RETURNS TABLE(event_type TEXT, event_id UUID, click_count BIGINT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT 'simple'::TEXT, c.event_id, count(*)::BIGINT
    FROM public.event_card_click AS c
   WHERE c.tenant_id = p_tenant_id
     AND c.event_id = ANY(COALESCE(p_simple_event_ids, '{}'::UUID[]))
   GROUP BY c.event_id
  UNION ALL
  SELECT 'complex'::TEXT, c.event_id, count(*)::BIGINT
    FROM public.complex_event_card_click AS c
   WHERE c.tenant_id = p_tenant_id
     AND c.event_id = ANY(COALESCE(p_complex_event_ids, '{}'::UUID[]))
   GROUP BY c.event_id;
$$;

REVOKE ALL ON FUNCTION public.record_event_card_click(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_event_card_click_counts(UUID, UUID[], UUID[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_event_card_click(UUID, UUID, TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_event_card_click_counts(UUID, UUID[], UUID[])
  TO service_role;

NOTIFY pgrst, 'reload schema';
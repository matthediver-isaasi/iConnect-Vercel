BEGIN;
LOCK TABLE public.membership_successor_rollout IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.membership_successor_rollout WHERE enabled) THEN
    RAISE EXCEPTION 'Global rollout is active; review migration before replacing it';
  END IF;
END;
$$;
-- No existing global enablement is inherited. Each tenant needs explicit approval.
CREATE TABLE public.membership_successor_tenant_rollout (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.membership_successor_tenant_rollout ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_successor_tenant_rollout FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.membership_successor_elections_enabled(p_tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT enabled FROM public.membership_successor_tenant_rollout
    WHERE tenant_id=p_tenant_id),false)
$$;
REVOKE ALL ON FUNCTION public.membership_successor_elections_enabled(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_successor_elections_enabled(uuid) TO service_role;

-- Old application versions cannot accidentally opt every tenant in.
CREATE OR REPLACE FUNCTION public.membership_successor_elections_enabled()
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT false
$$;

-- Preserve the installed reservation/recovery contract; only replace its gate.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.reserve_membership_successor(uuid,uuid,uuid,uuid,date,date,text,text,jsonb)'::regprocedure)
    INTO definition;
  IF position('IF NOT public.membership_successor_elections_enabled() THEN' IN definition)=0 THEN
    RAISE EXCEPTION 'Unexpected successor reservation contract; review before migrating';
  END IF;
  EXECUTE replace(definition,
    'IF NOT public.membership_successor_elections_enabled() THEN',
    'IF NOT public.membership_successor_elections_enabled(p_tenant_id) THEN');
END;
$$;
COMMIT;
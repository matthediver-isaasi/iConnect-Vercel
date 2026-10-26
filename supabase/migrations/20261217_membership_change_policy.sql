-- Preparatory policy storage only: no feature rollout, collections or refunds.
CREATE TABLE public.membership_change_policy (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
  revision bigint NOT NULL CHECK (revision > 0),
  policy jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);
CREATE TABLE public.membership_change_policy_history (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  revision bigint NOT NULL CHECK (revision > 0),
  policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  PRIMARY KEY (tenant_id,revision)
);
ALTER TABLE public.membership_change_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_change_policy_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_change_policy,public.membership_change_policy_history
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.membership_change_policy,public.membership_change_policy_history TO service_role;

CREATE FUNCTION public.save_membership_change_policy(
  p_tenant_id uuid, p_actor text, p_policy jsonb, p_expected_revision bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  v_revision bigint;
BEGIN
  IF p_actor IS NULL OR length(trim(p_actor))=0 OR length(p_actor)>200
     OR p_expected_revision IS NULL OR p_expected_revision<0
     OR p_policy IS NULL OR jsonb_typeof(p_policy) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid membership change policy' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_policy))<>6
     OR NOT (p_policy ?& ARRAY['surplusHandling','creditExpiryDays','upgradesRequireApproval',
       'downgradesRequireApproval','cancellationTiming','cancellationUnusedValue'])
     OR (p_policy->>'surplusHandling' IN ('approval','credit','refund')) IS DISTINCT FROM true
     OR (p_policy->>'cancellationTiming' IN ('end_of_term','immediate')) IS DISTINCT FROM true
     OR (p_policy->>'cancellationUnusedValue' IN ('none','tenant_surplus_policy')) IS DISTINCT FROM true
     OR jsonb_typeof(p_policy->'upgradesRequireApproval') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_policy->'downgradesRequireApproval') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Invalid membership change policy' USING ERRCODE='22023';
  END IF;
  IF p_policy->'creditExpiryDays'<>'null'::jsonb THEN
    IF jsonb_typeof(p_policy->'creditExpiryDays') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Invalid credit expiry' USING ERRCODE='22023';
    END IF;
    IF (p_policy->>'creditExpiryDays')::numeric NOT BETWEEN 1 AND 36500
       OR trunc((p_policy->>'creditExpiryDays')::numeric)<>(p_policy->>'creditExpiryDays')::numeric THEN
      RAISE EXCEPTION 'Invalid credit expiry' USING ERRCODE='22023';
    END IF;
  END IF;
  -- The tenant row also serializes the first insert; absent-row CAS is not a lock.
  PERFORM 1 FROM public.tenant t WHERE t.id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tenant unavailable' USING ERRCODE='23503'; END IF;
  SELECT p.revision INTO v_revision FROM public.membership_change_policy p WHERE p.tenant_id=p_tenant_id;
  IF coalesce(v_revision,0)<>p_expected_revision THEN
    RAISE EXCEPTION 'Settings changed' USING ERRCODE='40001';
  END IF;
  v_revision:=coalesce(v_revision,0)+1;
  INSERT INTO public.membership_change_policy(tenant_id,revision,policy,updated_by)
    VALUES(p_tenant_id,v_revision,p_policy,p_actor)
    ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,policy=excluded.policy,
      updated_by=excluded.updated_by,updated_at=now();
  INSERT INTO public.membership_change_policy_history(tenant_id,revision,policy,actor)
    VALUES(p_tenant_id,v_revision,p_policy,p_actor);
  RETURN jsonb_build_object('policy',p_policy,'revision',v_revision);
END $$;
REVOKE ALL ON FUNCTION public.save_membership_change_policy(uuid,text,jsonb,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_membership_change_policy(uuid,text,jsonb,bigint) TO service_role;
NOTIFY pgrst,'reload schema';

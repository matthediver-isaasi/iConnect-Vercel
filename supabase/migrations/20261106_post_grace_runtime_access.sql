BEGIN;
-- Runtime entry points remain service-only. Tenant opt-in is separate; this
-- migration never changes a member, payment, provider plan or tenant policy.
GRANT EXECUTE ON FUNCTION public.reserve_post_grace_renewal(uuid,uuid,uuid,uuid,text,bigint,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_post_grace_record_dates(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_post_grace_renewal_method(uuid,uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.post_grace_checkout_ready() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT has_function_privilege('service_role',
    'public.reserve_post_grace_renewal(uuid,uuid,uuid,uuid,text,bigint,text,jsonb)','EXECUTE')
    AND has_function_privilege('service_role',
    'public.apply_post_grace_record_dates(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb)','EXECUTE')
    AND has_function_privilege('service_role',
    'public.sync_post_grace_renewal_method(uuid,uuid,uuid)','EXECUTE');
$$;
REVOKE ALL ON FUNCTION public.post_grace_checkout_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.post_grace_checkout_ready() TO service_role;
COMMIT;

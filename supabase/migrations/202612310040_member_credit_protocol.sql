BEGIN;
CREATE FUNCTION public.member_credit_execution_available(p_protocol text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce(p_protocol='liability-backed-member-credit-v1'
   AND to_regprocedure('public.record_member_credit_funding_throttle(uuid,uuid,text,text,integer)') IS NOT NULL
   AND to_regclass('public.member_credit_funding_retry') IS NOT NULL,false)
$$;
CREATE OR REPLACE FUNCTION public.member_credit_execution_available()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.member_credit_execution_available(current_setting('iconnect.member_credit_protocol',true))
$$;
CREATE FUNCTION public.begin_member_credit_execution(
 p_tenant_id uuid,p_member_id uuid,p_authority_id uuid,p_actor_id uuid,p_choice text,p_reason text,p_protocol text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE previous text:=coalesce(current_setting('iconnect.member_credit_protocol',true),''); result jsonb;
BEGIN
 IF p_choice IS DISTINCT FROM 'credit' OR NOT public.member_credit_execution_available(p_protocol) THEN
   RAISE EXCEPTION 'Supported member credit protocol is required';
 END IF;
 PERFORM set_config('iconnect.member_credit_protocol',p_protocol,true);
 result:=public.begin_member_change_execution(p_tenant_id,p_member_id,p_authority_id,p_actor_id,p_choice,p_reason);
 PERFORM set_config('iconnect.member_credit_protocol',previous,true);
 RETURN result;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('iconnect.member_credit_protocol',previous,true);
 RAISE;
END $$;
REVOKE ALL ON FUNCTION public.member_credit_execution_available(text),
 public.begin_member_credit_execution(uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.member_credit_execution_available(text),
 public.begin_member_credit_execution(uuid,uuid,uuid,uuid,text,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

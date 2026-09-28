-- P0: Member AI data, controls, histories, and metering are server-side only.
-- Browser clients use authenticated API routes; they must never receive direct
-- PostgREST table or SECURITY DEFINER RPC access.

DO $$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'member_ai_conversation',
        'member_ai_message',
        'member_ai_settings',
        'member_ai_usage_event',
        'member_ai_public_usage_event',
        'member_ai_platform_settings'
      )
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      policy_row.policyname, policy_row.schemaname, policy_row.tablename
    );
  END LOOP;
END $$;

ALTER TABLE public.member_ai_conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_ai_conversation FORCE ROW LEVEL SECURITY;
ALTER TABLE public.member_ai_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_ai_message FORCE ROW LEVEL SECURITY;
ALTER TABLE public.member_ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_ai_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.member_ai_usage_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_ai_usage_event FORCE ROW LEVEL SECURITY;
ALTER TABLE public.member_ai_public_usage_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_ai_public_usage_event FORCE ROW LEVEL SECURITY;
ALTER TABLE public.member_ai_platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_ai_platform_settings FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.member_ai_conversation FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.member_ai_message FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.member_ai_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.member_ai_usage_event FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.member_ai_public_usage_event FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.member_ai_platform_settings FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.member_ai_conversation TO service_role;
GRANT ALL ON TABLE public.member_ai_message TO service_role;
GRANT ALL ON TABLE public.member_ai_settings TO service_role;
GRANT ALL ON TABLE public.member_ai_usage_event TO service_role;
GRANT ALL ON TABLE public.member_ai_public_usage_event TO service_role;
GRANT ALL ON TABLE public.member_ai_platform_settings TO service_role;

CREATE POLICY member_ai_conversation_service_role_only
  ON public.member_ai_conversation AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY member_ai_message_service_role_only
  ON public.member_ai_message AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY member_ai_settings_service_role_only
  ON public.member_ai_settings AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY member_ai_usage_event_service_role_only
  ON public.member_ai_usage_event AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY member_ai_public_usage_event_service_role_only
  ON public.member_ai_public_usage_event AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY member_ai_platform_settings_service_role_only
  ON public.member_ai_platform_settings AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- All three claims are SECURITY DEFINER and write quota state.  In particular,
-- public usage metering is invoked by a server endpoint, not directly by an
-- anonymous browser role.
REVOKE ALL ON FUNCTION public.claim_member_ai_usage(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_public_member_ai_usage(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_admin_member_ai_usage(uuid, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_member_ai_usage(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_public_member_ai_usage(uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_admin_member_ai_usage(uuid, text, text)
  TO service_role;
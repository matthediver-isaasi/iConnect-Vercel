-- Historical shown=true means only "displayed", not a user decision. Do not
-- backfill acknowledgment from it, or erase either explicit hide preference.
ALTER TABLE public.member_inbox_alert_login
  ADD COLUMN IF NOT EXISTS acknowledged boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.set_inbox_alert_preference(
  p_sid varchar, p_tenant uuid, p_member uuid, p_field text, p_value boolean
) RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF p_value IS NULL OR p_field IS NULL
    OR p_field NOT IN ('always_hide', 'hide_until_login', 'shown', 'acknowledged')
    OR (p_field IN ('shown', 'acknowledged') AND NOT p_value) THEN
    RAISE EXCEPTION 'Invalid alert preference';
  END IF;
  IF p_field = 'always_hide' THEN
    INSERT INTO member_inbox_alert_preference (tenant_id, member_id, always_hide)
      VALUES (p_tenant, p_member, p_value)
      ON CONFLICT (tenant_id, member_id) DO UPDATE SET always_hide = EXCLUDED.always_hide;
  ELSIF p_field = 'hide_until_login' THEN
    INSERT INTO member_inbox_alert_login (sid, tenant_id, member_id, hide_until_login)
      VALUES (p_sid, p_tenant, p_member, p_value)
      ON CONFLICT (sid, tenant_id, member_id) DO UPDATE SET hide_until_login = EXCLUDED.hide_until_login;
  ELSIF p_field = 'acknowledged' THEN
    INSERT INTO member_inbox_alert_login (sid, tenant_id, member_id, acknowledged)
      VALUES (p_sid, p_tenant, p_member, true)
      ON CONFLICT (sid, tenant_id, member_id) DO UPDATE SET acknowledged = true;
  ELSE
    -- Older servers may still record display during deployment; never interpret
    -- that write as an explicit action.
    INSERT INTO member_inbox_alert_login (sid, tenant_id, member_id, shown)
      VALUES (p_sid, p_tenant, p_member, true)
      ON CONFLICT (sid, tenant_id, member_id) DO UPDATE SET shown = true;
  END IF;
  IF NOT p_value THEN
    UPDATE member_inbox_alert_login SET shown = false, acknowledged = false
      WHERE sid = p_sid AND tenant_id = p_tenant AND member_id = p_member;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_inbox_alert_preference(varchar, uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_inbox_alert_preference(varchar, uuid, uuid, text, boolean) TO service_role;

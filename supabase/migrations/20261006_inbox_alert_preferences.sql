-- Popup-only preferences. No grants to browser roles or generic entity API.
CREATE TABLE IF NOT EXISTS public.member_inbox_alert_preference (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.member(id) ON DELETE CASCADE,
  always_hide boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, member_id)
);
CREATE TABLE IF NOT EXISTS public.member_inbox_alert_login (
  sid varchar NOT NULL REFERENCES public.session(sid) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.member(id) ON DELETE CASCADE,
  hide_until_login boolean NOT NULL DEFAULT false,
  shown boolean NOT NULL DEFAULT false,
  PRIMARY KEY (sid, tenant_id, member_id)
);
ALTER TABLE public.member_inbox_alert_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_inbox_alert_login ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_inbox_alert_preference, public.member_inbox_alert_login FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_inbox_alert_preference, public.member_inbox_alert_login TO service_role;

CREATE OR REPLACE FUNCTION public.set_inbox_alert_preference(
  p_sid varchar, p_tenant uuid, p_member uuid, p_field text, p_value boolean
) RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF p_value IS NULL OR p_field NOT IN ('always_hide', 'hide_until_login', 'shown')
    OR (p_field = 'shown' AND NOT p_value) THEN
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
  ELSE
    INSERT INTO member_inbox_alert_login (sid, tenant_id, member_id, shown)
      VALUES (p_sid, p_tenant, p_member, true)
      ON CONFLICT (sid, tenant_id, member_id) DO UPDATE SET shown = true;
  END IF;
  -- Explicit reversal restores eligibility; visiting Inbox itself never opens it.
  IF NOT p_value THEN
    UPDATE member_inbox_alert_login SET shown = false
      WHERE sid = p_sid AND tenant_id = p_tenant AND member_id = p_member;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_inbox_alert_preference(varchar, uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_inbox_alert_preference(varchar, uuid, uuid, text, boolean) TO service_role;

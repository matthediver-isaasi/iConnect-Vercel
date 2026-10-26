-- No backfill: old completed actions are deliberately outside this contract.
ALTER TABLE public.membership_expiry_action ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_expiry_action FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.membership_expiry_action TO service_role;
ALTER TABLE public.membership_expiry_action
  ADD COLUMN IF NOT EXISTS role_event_before jsonb,
  ADD COLUMN IF NOT EXISTS role_event_after jsonb,
  ADD COLUMN IF NOT EXISTS role_event_state text
    CHECK (role_event_state IN ('pending', 'completed', 'review')),
  ADD COLUMN IF NOT EXISTS role_event_error text;
CREATE INDEX IF NOT EXISTS membership_expiry_role_pending_idx
  ON public.membership_expiry_action(tenant_id, id)
  WHERE role_event_state IN ('pending', 'review');

CREATE OR REPLACE FUNCTION public.apply_annual_expiry_role(p_tenant_id uuid, p_action_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.membership_expiry_action; m public.member; updated public.member;
BEGIN
  SELECT * INTO a FROM public.membership_expiry_action
    WHERE id = p_action_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND OR a.action_state <> 'pending' OR a.role_event_state IS NOT NULL
    OR a.assigned_role_id IS NULL OR a.previous_role_id IS NOT DISTINCT FROM a.assigned_role_id THEN RETURN; END IF;
  SELECT * INTO m FROM public.member
    WHERE id = a.member_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND OR m.role_id IS DISTINCT FROM a.previous_role_id
    OR m.membership_paused IS TRUE THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.role WHERE id = m.role_id
      AND tenant_id = p_tenant_id AND is_tenant_admin IS TRUE) THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.role WHERE id = a.assigned_role_id
      AND tenant_id = p_tenant_id AND is_tenant_admin IS NOT TRUE)
    THEN RAISE EXCEPTION 'Invalid expiry fallback role'; END IF;
  UPDATE public.member SET role_id = a.assigned_role_id
    WHERE id = m.id AND tenant_id = p_tenant_id RETURNING * INTO updated;
  UPDATE public.membership_expiry_action SET role_event_before = to_jsonb(m),
    role_event_after = to_jsonb(updated), role_event_state = 'pending'
    WHERE id = a.id AND tenant_id = p_tenant_id;
END $$;
REVOKE ALL ON FUNCTION public.apply_annual_expiry_role(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_annual_expiry_role(uuid, uuid) TO service_role;

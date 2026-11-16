-- Owner-approved BNMS policy: future post-grace Former assignments become
-- CPD Guest. Purchase snapshots and completed expiry transitions stay immutable.
-- The worker reloads this journal before applying roles and dispatching events,
-- so the persisted target and the actual transition remain consistent.
CREATE OR REPLACE FUNCTION public.bnms_post_grace_guest_role()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  target_role uuid := 'b640bd84-3d84-4cde-9f27-c3e80edb762f';
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
    OR NEW.history_type IS DISTINCT FROM 'member'
    OR NEW.action_state IS DISTINCT FROM 'pending'
    OR NEW.assigned_role_id IS DISTINCT FROM 'd536896d-b43a-4377-89ef-6c95f1496358'::uuid
  THEN RETURN NEW; END IF;

  -- Refuse invalid ownership or a missing/privileged target, never silently
  -- downgrade the policy to its obsolete role.
  PERFORM 1 FROM public.member_membership_history h
    JOIN public.member m ON m.id=h.member_id AND m.tenant_id=h.tenant_id
    WHERE h.id=NEW.history_id AND h.tenant_id=NEW.tenant_id
      AND h.member_id=NEW.member_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'BNMS expiry role policy ownership mismatch'; END IF;
  PERFORM 1 FROM public.role r
    WHERE r.id=target_role AND r.tenant_id=NEW.tenant_id
      AND coalesce(r.is_admin,false)=false AND coalesce(r.is_tenant_admin,false)=false
    FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BNMS expiry role policy target unavailable'; END IF;
  NEW.details := coalesce(NEW.details,'{}'::jsonb) || jsonb_build_object(
    'role_policy_override',jsonb_build_object(
      'source_role_id',NEW.assigned_role_id,
      'target_role_id',target_role,
      'approval_reference','BNMS operator-approved post-grace CPD Guest policy, 2026-11-16',
      'recorded_at',transaction_timestamp()));
  NEW.assigned_role_id := target_role;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.bnms_post_grace_guest_role() FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS bnms_post_grace_guest_role ON public.membership_expiry_action;
CREATE TRIGGER bnms_post_grace_guest_role
BEFORE INSERT ON public.membership_expiry_action
FOR EACH ROW EXECUTE FUNCTION public.bnms_post_grace_guest_role();

NOTIFY pgrst,'reload schema';

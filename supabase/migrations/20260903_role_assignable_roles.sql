-- Tenant role assignment policy. Existing roles intentionally gain no powers.
ALTER TABLE role
  ADD COLUMN IF NOT EXISTS assignable_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE role
SET assignable_role_ids = '[]'::jsonb
WHERE assignable_role_ids IS NULL
   OR jsonb_typeof(assignable_role_ids) <> 'array';

-- Serialize role-capacity checks per organisation/role so concurrent updates
-- cannot both pass a count-then-update check in the API.
CREATE OR REPLACE FUNCTION enforce_member_role_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  role_limit integer;
  active_count integer;
  role_name text;
BEGIN
  IF NEW.role_id IS NULL OR NEW.login_enabled IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.role_id IS NOT DISTINCT FROM OLD.role_id
     AND NEW.login_enabled IS NOT DISTINCT FROM OLD.login_enabled
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN
    RETURN NEW;
  END IF;

  SELECT max_members, name
  INTO role_limit, role_name
  FROM role
  WHERE id = NEW.role_id
    AND tenant_id = NEW.tenant_id;

  IF role_limit IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'ROLE_CAPACITY_EXCEEDED: Organisation context is required to assign the "%" role.',
      role_name
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(NEW.organization_id::text || ':' || NEW.role_id::text));

  SELECT count(*)
  INTO active_count
  FROM member
  WHERE organization_id = NEW.organization_id
    AND role_id = NEW.role_id
    AND login_enabled IS TRUE
    AND (TG_OP = 'INSERT' OR id <> NEW.id);

  IF active_count >= role_limit THEN
    RAISE EXCEPTION 'ROLE_CAPACITY_EXCEEDED: The "%" role is full (%/%) for this organisation.',
      role_name, active_count, role_limit
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_role_capacity_insert_guard ON member;
CREATE TRIGGER member_role_capacity_insert_guard
BEFORE INSERT ON member
FOR EACH ROW
EXECUTE FUNCTION enforce_member_role_capacity();

DROP TRIGGER IF EXISTS member_role_capacity_update_guard ON member;
CREATE TRIGGER member_role_capacity_update_guard
BEFORE UPDATE OF role_id, login_enabled, organization_id ON member
FOR EACH ROW
EXECUTE FUNCTION enforce_member_role_capacity();
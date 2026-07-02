-- Bump member.updated_at / organization.updated_at whenever a row in
-- the corresponding *_preference_value table changes. This is the
-- parent-watermark mechanism described in
-- docs/zoho-sync-reconcile-design.md §5: the outbound reconcile cron
-- only scans parent tables, and a pref-value change is conceptually a
-- write to the parent record.
--
-- Both triggers use COALESCE(NEW, OLD) so a single function handles
-- INSERT, UPDATE and DELETE. They are AFTER triggers so they never
-- block the originating write transaction's logic. If a single
-- transaction toggles many preferences for the same parent, the
-- trigger fires once per row and bumps `updated_at` repeatedly within
-- that transaction — that is fine functionally (the final value is
-- the commit time) and Postgres absorbs the cost cheaply.

CREATE OR REPLACE FUNCTION bump_member_updated_at_from_pref()
RETURNS TRIGGER AS $$
DECLARE
  parent_id UUID;
BEGIN
  parent_id := COALESCE(NEW.member_id, OLD.member_id);
  IF parent_id IS NOT NULL THEN
    UPDATE member SET updated_at = NOW() WHERE id = parent_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_member_pref_value_bump_parent ON member_preference_value;
CREATE TRIGGER trg_member_pref_value_bump_parent
AFTER INSERT OR UPDATE OR DELETE ON member_preference_value
FOR EACH ROW EXECUTE FUNCTION bump_member_updated_at_from_pref();

CREATE OR REPLACE FUNCTION bump_organization_updated_at_from_pref()
RETURNS TRIGGER AS $$
DECLARE
  parent_id UUID;
BEGIN
  parent_id := COALESCE(NEW.organization_id, OLD.organization_id);
  IF parent_id IS NOT NULL THEN
    UPDATE organization SET updated_at = NOW() WHERE id = parent_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_organization_pref_value_bump_parent ON organization_preference_value;
CREATE TRIGGER trg_organization_pref_value_bump_parent
AFTER INSERT OR UPDATE OR DELETE ON organization_preference_value
FOR EACH ROW EXECUTE FUNCTION bump_organization_updated_at_from_pref();

COMMENT ON FUNCTION bump_member_updated_at_from_pref IS
  'Bumps member.updated_at when a member_preference_value row is inserted, updated, or deleted. Used by the Zoho CRM outbound reconcile cron to detect drift.';
COMMENT ON FUNCTION bump_organization_updated_at_from_pref IS
  'Bumps organization.updated_at when an organization_preference_value row is inserted, updated, or deleted. Used by the Zoho CRM outbound reconcile cron to detect drift.';

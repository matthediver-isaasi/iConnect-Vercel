-- Tombstone capture for member / organization hard-deletes so the
-- outbound reconcile cron can drain them to Zoho CRM. See
-- docs/zoho-sync-reconcile-design.md §6.
--
-- The triggers fire AFTER DELETE inside the originating transaction,
-- so a rolled-back delete also rolls back the tombstone (no false
-- positives). The tombstone snapshots `zoho_crm_id` and
-- `zoho_crm_module` at delete time because the engine needs them to
-- call Zoho's `DELETE /crm/v3/<module>/<id>` endpoint and they are
-- gone from the parent table by the time the cron runs.
--
-- Garbage collection of processed rows is intentionally deferred to a
-- separate housekeeping job; processed tombstones double as an audit
-- trail in the meantime.

CREATE TABLE IF NOT EXISTS zoho_crm_sync_tombstone (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('member', 'organization')),
  entity_id       UUID NOT NULL,
  zoho_crm_id     TEXT,
  zoho_crm_module TEXT,
  deleted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_zoho_crm_sync_tombstone_pending
  ON zoho_crm_sync_tombstone (tenant_id, entity_type, deleted_at)
  WHERE processed_at IS NULL;

COMMENT ON TABLE zoho_crm_sync_tombstone IS
  'Records member/organization hard-deletes so the outbound reconcile cron can propagate them to Zoho CRM.';

CREATE OR REPLACE FUNCTION record_member_zoho_tombstone()
RETURNS TRIGGER AS $$
BEGIN
  -- Only capture when the row had a tenant_id (defensive — the column
  -- is non-null in practice but a degenerate row should not abort the
  -- delete transaction). When zoho_crm_id is null the cron sees that
  -- there is nothing to delete in Zoho and immediately marks the
  -- tombstone processed.
  IF OLD.tenant_id IS NOT NULL THEN
    INSERT INTO zoho_crm_sync_tombstone
      (tenant_id, entity_type, entity_id, zoho_crm_id, zoho_crm_module)
    VALUES
      (OLD.tenant_id, 'member', OLD.id, OLD.zoho_crm_id, OLD.zoho_crm_module);
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_member_zoho_tombstone ON member;
CREATE TRIGGER trg_member_zoho_tombstone
AFTER DELETE ON member
FOR EACH ROW EXECUTE FUNCTION record_member_zoho_tombstone();

CREATE OR REPLACE FUNCTION record_organization_zoho_tombstone()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.tenant_id IS NOT NULL THEN
    INSERT INTO zoho_crm_sync_tombstone
      (tenant_id, entity_type, entity_id, zoho_crm_id, zoho_crm_module)
    VALUES
      (OLD.tenant_id, 'organization', OLD.id, OLD.zoho_crm_id, OLD.zoho_crm_module);
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_organization_zoho_tombstone ON organization;
CREATE TRIGGER trg_organization_zoho_tombstone
AFTER DELETE ON organization
FOR EACH ROW EXECUTE FUNCTION record_organization_zoho_tombstone();

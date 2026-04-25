-- Per-mapping `deletion_policy` for the inbound delete webhook
-- (see api/zoho-crm/webhook/delete.js). Mirrors `unmatched_policy`
-- in shape and conservative defaults: when Zoho tells us a record
-- was deleted, the engine looks at this column on the matching
-- mapping to decide whether to ignore the event, unlink the iConnect
-- entity from Zoho (clear zoho_crm_id), or hard-delete the entity.
--
-- Default 'ignore' means existing tenants see the new endpoint as a
-- no-op until they explicitly opt in to a stronger action — the
-- matching pattern used by `unmatched_policy` shipped earlier.

ALTER TABLE zoho_crm_sync_mapping
  ADD COLUMN IF NOT EXISTS deletion_policy TEXT NOT NULL DEFAULT 'ignore'
    CHECK (deletion_policy IN ('ignore', 'unlink', 'delete'));

COMMENT ON COLUMN zoho_crm_sync_mapping.deletion_policy IS
  'Action taken when Zoho notifies iConnect of a record deletion via the inbound delete webhook: ignore (log only), unlink (clear zoho_crm_id), or delete (hard-delete the iConnect entity).';

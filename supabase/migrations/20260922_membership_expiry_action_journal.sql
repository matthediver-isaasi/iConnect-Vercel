-- Existing actions were written after access mutations but before session
-- invalidation. Completed histories prove completion; interrupted histories need
-- idempotent repair without replacing their original provenance.
-- New workers insert pending intent BEFORE any access mutation.
-- Deploy before the bounded expiry worker.
ALTER TABLE membership_expiry_action
  ADD COLUMN IF NOT EXISTS action_state TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

UPDATE membership_expiry_action AS action
SET action_state = 'pending'
WHERE action.completed_at IS NULL
  AND action.details->>'source' = 'annual_membership_expiry_sweep'
  AND (
    (action.history_type = 'member' AND EXISTS (
      SELECT 1 FROM member_membership_history AS history
      WHERE history.id = action.history_id AND history.tenant_id = action.tenant_id
        AND history.expiry_enforced_at IS NULL
    ))
    OR
    (action.history_type = 'organisation' AND EXISTS (
      SELECT 1 FROM organisation_membership_history AS history
      WHERE history.id = action.history_id AND history.tenant_id = action.tenant_id
        AND history.expiry_enforced_at IS NULL
    ))
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_expiry_action_state_check') THEN
    ALTER TABLE membership_expiry_action
      ADD CONSTRAINT membership_expiry_action_state_check
      CHECK (action_state IN ('pending', 'completed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS member_membership_history_expiry_keyset_idx
  ON member_membership_history (tenant_id, id) WHERE expiry_enforced_at IS NULL;
CREATE INDEX IF NOT EXISTS organisation_membership_history_expiry_keyset_idx
  ON organisation_membership_history (tenant_id, id) WHERE expiry_enforced_at IS NULL;
CREATE INDEX IF NOT EXISTS member_organisation_expiry_keyset_idx
  ON member (tenant_id, organization_id, id);
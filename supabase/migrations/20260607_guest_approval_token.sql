-- Guest signup approval tokens (Task #1269)
-- Stores a single pending approve/deny action for a guest member created via
-- the guest-stamp signup path. Each row backs the tokenised Approve/Deny links
-- emailed to the tenant roles configured on the Guest Access card. The action
-- is single-use: once `status` moves from 'pending' to 'approved'/'denied' the
-- public endpoint refuses to re-action and shows an "already handled" message.

CREATE TABLE IF NOT EXISTS guest_approval_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  organization_id uuid,
  guest_name text,
  guest_email text,
  organization_name text,
  guest_expires_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guest_approval_token_token ON guest_approval_token(token);
CREATE INDEX IF NOT EXISTS idx_guest_approval_token_member ON guest_approval_token(member_id);
CREATE INDEX IF NOT EXISTS idx_guest_approval_token_tenant ON guest_approval_token(tenant_id);

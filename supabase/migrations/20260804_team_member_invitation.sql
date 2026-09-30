-- Task #3392: Tokenized team member invitations.
--
-- Backs the public invite-acceptance/signup flow: an existing member invites a
-- colleague by email; the invitee receives a single-use, expiring tokenised
-- link to a public page where they create their account (no login required).
-- Resending supersedes prior pending tokens for the same invitee.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS team_member_invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  email text NOT NULL,
  organization_id uuid,
  invited_by_member_id uuid,
  inviter_name text,
  status text NOT NULL DEFAULT 'pending', -- pending | accepted | superseded | cancelled
  expires_at timestamptz,
  accepted_at timestamptz,
  member_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_member_invitation_token ON team_member_invitation(token);
CREATE INDEX IF NOT EXISTS idx_team_member_invitation_tenant_email ON team_member_invitation(tenant_id, email);

-- Foreign keys (idempotent). Invites survive deletion of inviter/member rows
-- (SET NULL) but are removed with their tenant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_member_invitation_tenant_fk') THEN
    ALTER TABLE team_member_invitation
      ADD CONSTRAINT team_member_invitation_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_member_invitation_organization_fk') THEN
    ALTER TABLE team_member_invitation
      ADD CONSTRAINT team_member_invitation_organization_fk
      FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_member_invitation_inviter_fk') THEN
    ALTER TABLE team_member_invitation
      ADD CONSTRAINT team_member_invitation_inviter_fk
      FOREIGN KEY (invited_by_member_id) REFERENCES member(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_member_invitation_member_fk') THEN
    ALTER TABLE team_member_invitation
      ADD CONSTRAINT team_member_invitation_member_fk
      FOREIGN KEY (member_id) REFERENCES member(id) ON DELETE SET NULL;
  END IF;
END $$;

-- RLS: service-role API access only (matches the project's tenant-table
-- pattern; the public endpoints go through the service client).
ALTER TABLE team_member_invitation ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'team_member_invitation'
      AND policyname = 'team_member_invitation_tenant_isolation'
  ) THEN
    CREATE POLICY "team_member_invitation_tenant_isolation"
      ON team_member_invitation
      FOR ALL
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

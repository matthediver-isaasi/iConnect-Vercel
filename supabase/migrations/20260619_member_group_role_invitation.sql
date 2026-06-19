-- Task #1608: Member group role invitations.
--
-- Backs the tokenised invite-and-accept flow: an admin/group-admin invites an
-- existing member into a specific role on a member group. The invitee receives
-- an email with a one-time link to a branded page showing the role's terms of
-- reference, where they accept (creating/updating a member_group_assignment) or
-- decline. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS member_group_role_invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  group_id uuid NOT NULL,
  member_id uuid NOT NULL,
  group_role text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz,
  invited_by_member_id uuid,
  assignment_id uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_member_group_role_invitation_token ON member_group_role_invitation(token);
CREATE INDEX IF NOT EXISTS idx_member_group_role_invitation_group ON member_group_role_invitation(group_id);
CREATE INDEX IF NOT EXISTS idx_member_group_role_invitation_tenant ON member_group_role_invitation(tenant_id);
CREATE INDEX IF NOT EXISTS idx_member_group_role_invitation_member ON member_group_role_invitation(member_id);

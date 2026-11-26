# Project board ownership safeguards

## Behaviour

All new boards receive their creator as Owner inside the board-creation
transaction, including ordinary Projects, Member Group boards, automatic group
boards and existing Sales creation functions. A failed owner insertion rolls
back the new board. The old explicit creator-membership insertion remains
compatible and cannot downgrade the newly assigned Owner.

Membership changes serialize on the board. The last Owner cannot be demoted,
removed or moved to another board; another Owner must first be assigned.
Deleting the complete board still cascades normally. Sharing upserts preserve
existing Owners rather than silently changing their roles.

The API uses the authenticated session's tenant and actor, checks board scope
and rechecks current membership authority under the database lock. Only Owners
may grant or change ownership, including when inviting new members. Conflicts
return actionable HTTP 409 messages without unsafe fallback writes.

Settings disable the final Owner's role selector and explain the handoff
requirement. A second Owner permits a normal handoff.

## Installation and verification

Source: `supabase/migrations/202702060001_project_board_ownership.sql`.
Installed as `20261126141728_project_board_ownership_guards` on destination
`lvmzliemqnieeoruhkik`. The guard installation verified that all existing
membership rows remained unchanged. A separately approved, single-board
creator-owner repair was then installed independently; this does not authorize
automatic reassignment on other legacy ownerless boards.

The live-schema rollback rehearsal exercised service-role board creation,
legacy duplicate insertion, rejected last-owner demotion/deletion and parent
deletion. No rehearsal records survived. Independent reads confirmed enabled
triggers, invoker security and service-only function grants.

Thirteen focused checks cover API authority/errors, real settings-control
logic and isolated PostgreSQL, including concurrent raw/API changes, owner
handoff, creation rollback, cross-tenant denial and historical ownerless boards.
Private verification metadata is retained in the ignored, deployment-excluded
`generated-artifacts/project-board-ownership-rollout/` directory.

The database protections and approved repair are live. The API/UI changes need
the usual Vercel deployment. The signed-in browser screen could not be checked
through the development preview because of its existing tenant-resolution
failure; the settings-control tests are not a full browser verification.

---
name: Member group role name canonicalisation
description: Group role names are free text duplicated across ~7 surfaces; renames/merges must touch all of them, client-side only enforcement.
---

Group "roles" are free-text strings, not IDs, and each spelling is duplicated across: `member_group.roles`, `leadership_roles`, `projects_enabled_roles`, `forum_enabled_roles`, `default_self_join_role`, three role-KEYED JSONB maps (`role_terms_of_reference`, `role_terms_url`, `role_term_definitions`), `member_group_assignment.group_role`, and `member_group_role_invitation.group_role`.

**Rule:** any rename/merge of a role name must rewrite ALL of those surfaces together; when merging case-only duplicates, prefer the variant carrying JSONB metadata, then the one with most assignments.

**Why:** cleanup one place and the others silently drift (metadata lookups are exact-string keyed, so a case change orphans terms-of-reference/term definitions).

**How to apply:** shared helpers in `client/src/lib/memberGroupRoleNames.js` (Title Case preserving all-caps acronyms, case-insensitive key match); bulk cleanup via `scripts/normalize-member-group-roles.mjs` (idempotent, dry-run default). Canonicalisation is enforced client-side only (MemberGroupManagement.jsx) — other write paths (vacancies, invites API) can still introduce variants.

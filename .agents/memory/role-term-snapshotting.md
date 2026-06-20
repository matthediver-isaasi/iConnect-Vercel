---
name: Role term snapshotting
description: How role term length / max-terms flow from role definition to a member's assignment snapshot.
---

Term length (value+unit) and max-terms are a property of the ROLE definition,
stored in `member_group.role_term_definitions` (JSONB keyed by role title:
`{ term_value, term_unit, max_terms }`). Vacancy postings show the role's term
read-only (auto-filled from the role def, not free-entered). At award time
(client) and invite-accept time (server) a FIXED snapshot is written onto
`member_group_assignment` (`term_length_value/unit`, `max_terms`,
`term_start_date/end_date`, `term_number`).

**Why:** later edits to a role's term must NOT retroactively change an
already-awarded member's recorded term — hence the snapshot.

**How to apply:**
- The snapshot logic is duplicated in two files that MUST stay in sync:
  `client/src/lib/memberGroupTermSnapshot.js` and
  `api/_lib/memberGroupTermSnapshot.js` (the api/** root and client/** root
  can't share a module). Change both together.
- `term_number` increments only when renewing into the SAME role on an existing
  assignment; a new/different role resets to 1 (single-assignment-per-member-
  per-group model).
- A role with no term definition yields an all-null snapshot (no term shown).
- Term details on the member card are admin-only (gated by `isGroupAdmin`).
- Group admins can correct a snapshot directly (start/end date + term_number)
  via an edit affordance on the member card (`TermDetails` onEdit →
  `EditTermDialog` → `MemberGroupAssignment.update`). This bypasses
  `buildTermSnapshot` deliberately — it writes raw fields and never reads the
  role def. The entity-API orphan guard only fires on `is_group_admin`/
  `expires_at` changes, so term-field patches pass through.
- There is a separate direct admin-assign path
  (`MemberGroupManagement.jsx` assignForm → `MemberGroupAssignment.create`)
  that does NOT snapshot terms — out of original scope.

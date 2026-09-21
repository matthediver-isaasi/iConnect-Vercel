# NMC Journal RBAC data update

Applied on 2026-09-21 using `migrate-bnms-nmc-journal-rbac.mjs`.

## Destination and scope

- Database: verified DEST Supabase project `lvmzliemqnieeoruhkik`.
- Tenant: BNMS (`ff2df806-b321-4254-b651-3af11fccf1db`).
- SOURCE and development database: not modified.
- Schema migrations: none needed. This was a data-only migration.
- Added one global `role_access_item` page, `content.nmc-journal`, labeled
  **NMC Journal**, beneath the existing **Content Publishing** module.
- Changed only `feature_id` on BNMS menu row
  `9a5aa193-6387-444d-9ee4-30c06763bb62`, from `page_user_NMCJournal`
  to `content.nmc-journal`.
- No matching legacy permission-tree row or navigation row existed.
- No role rows required translation. All 14 BNMS roles were inspected.
- No BNMS role excludes Content, including its known legacy aliases; no new
  parent restriction was found. No role access was broadened.

## Preserved menu settings

The transaction compared the entire menu record before and after, allowing
only the permission key to differ:

- Label: NMC Journal
- Destination: `https://journals.lww.com/nuclearmedicinecomm/pages/default.aspx`
- External link, new tab enabled
- Icon: BookOpen
- Active: true
- Section: user
- Parent: none
- Display order: 5

Transactional fingerprints confirmed all other menu records, all navigation
records, all roles, and all pre-existing permission-tree rows were unchanged.

## Repeatability

The initial reviewed snapshot hash was
`9cac84c5d31d7c07e26e522e59eb8a4b9a723fcca7ee0c8a319f948b8b20d914`.
The apply inserted one permission, updated one menu, and changed zero roles.

A fresh dry run followed by a second apply using snapshot hash
`601f8baffa2974532805a4e75a34af18ac27741d59d104b9dc9d393385271136`
inserted zero permissions, updated zero menus, and changed zero roles.

For future execution, run the script without arguments and review its output,
then use `--apply --review-sha256=<fresh-reviewHash>`. Changed identities,
unexpected references, duplicate canonical rows, or an unexpected legacy tree
row stop the operation for review rather than rewriting shared references.

## Verification and remaining rollout

- Client map and external-link suite: 45 passing tests.
- Server visibility suite: 9 passing tests.
- Isolated migration suite: 3 passing tests.
- Browser suite: 6 passing tests covering NMC Journal picker save/reload,
  Content tree, non-admin allow/canonical deny/legacy deny/parent deny, and
  administrator behavior without a blanket permission bypass.
- No database migration remains outstanding.
- Browser tests used isolated API fixtures, not live member sessions. The
  normal workspace preview has an existing default-tenant resolution error.
- Frontend publication was not performed. Deployment of the source changes
  and a subsequent authenticated production smoke test remain rollout steps;
  database configuration alone does not prove the published picker has updated.
- Direct publisher authentication and access to the external website are
  unchanged and outside this permission's scope.
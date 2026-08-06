---
name: RBAC feature key rollout
description: What it takes for a new role-access key to actually appear in Role Management in prod (DB-driven map, not the hardcoded one).
---

# Rolling out a new RBAC feature key

Adding a key to `ROLE_ACCESS_MAP` (client/src/lib/roleAccessMap.ts) is NOT
enough for it to show in /rolemanagement in prod. `RoleManagement.jsx` builds
its access map from the GLOBAL `role_access_item` table whenever that table has
rows (it does in prod — the hardcoded map is only a fallback for an empty
table). The DB rows drift from the map: keys added since the original seed are
missing unless someone inserts them.

**How to apply:** ship the key in three layers:
1. `ROLE_ACCESS_MAP` (client) — used by exclusion checks + suggestions.
2. Server enforcement via `resolveMemberExclusions` + `makeFeatureAccessChecker`
   (`api/_lib/memberFeatureAccess.js`) — 403 excluded members on every endpoint.
3. An idempotent `scripts/seed-*-role-access.mjs` insert of the
   `role_access_item` page row under its module (pattern:
   `seed-member-ai-role-access.mjs`, dry-run default, `--apply` to write).

**Why:** deny-list model means visible-by-default works without any DB row, but
admins can't untick a key that isn't rendered in Role Management. Only backfill
the key into roles' `excluded_features` when the feature must ship OFF by
default (see `seed-pending-po-role-access.mjs` for that heavier pattern).

Brand-new keys need NO entry in the legacy mapping (`LEGACY_TO_NEW_MAPPING` in
both roleVisibility files) — that's only for renamed/legacy IDs.

**Also:** after editing `ROLE_ACCESS_MAP` or `LEGACY_TO_NEW_MAPPING`, re-run
`npx tsx scripts/generate-role-access-hierarchy.mjs` to regenerate
`api/_lib/roleAccessHierarchy.generated.js`, or the no-drift tests in
`client/src/lib/roleAccessMap.test.ts` fail.

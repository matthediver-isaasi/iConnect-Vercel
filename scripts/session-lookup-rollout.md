# Session lookup error rollout

## Cause and scope

Read-only inspection of external DEST on 2026-11-18 confirmed that
`tenant_membership` links to `tenant_identity` and `tenant`, has a unique
identity/tenant pair, and has no `tenant_user_id` column or relationship.
`tenant_user.identity_id` links to `tenant_identity`.

`getTenantContext` calls `getSessionTenantUser` before resolving ordinary member
access. Member sessions with an identity therefore repeatedly entered promotion.
The former mandatory direct-account lookup generated legitimate-absence errors,
then its fallback requested the nonexistent relationship.

The correction uses optional direct-account reads and tenant-scoped unified
membership/identity reads. It reuses the unified user compatibility contract
already used for administrator sessions. Backend failures throw
`SESSION_UNAVAILABLE`; they do not grant access or impersonate absence.
No cross-request authority cache, new accounts, role policy, live data or schema
changes are introduced. Existing member session fences and team suspension checks
remain in place.

## Verification

Run:

```sh
node scripts/run-isolated-tests.mjs node --test --test-concurrency=1 api/_lib/sessionPromotion.test.mjs api/_lib/sessionLookup.continuity.test.mjs api/_lib/sessionAvailability.test.mjs api/_lib/organisationLoginAccess.test.mjs api/tenant/team.test.mjs
```

The 39 checks passed, including repeated ordinary-member absence, unified and
legacy administration, role revocation on the next request, inactive accounts,
cross-tenant isolation, backend failures, duplicate links, session fence refusal,
member login disablement, membership pause and dual portal/team access.
The existing team test adapter was updated for the current session wrappers and
literal email matching so those lifecycle assertions execute rather than fail
on missing test dependencies.

## Deployment gate

Code deployment was verified on 2026-11-18. No database migration is required.
Vercel production target `dpl_BJUtUPHBw36zKfbE6K6TgbkKyKQk` was READY/PROMOTED,
serving commit `96c17812865e2da890886579df410b9ce18785c7`, with aliases assigned
at 12:37:12.522 UTC. The commit's session implementation contains the corrected
optional lookup and membership query.

After deployment, verify the serving revision contains this change, then inspect
completed fixed UTC windows of Supabase errors. Historical baseline:
71,657 PGRST200 relationship failures over 2026-11-16 15:33 to
2026-11-17 15:33 UTC, with matching optional tenant-user PGRST116 responses.
Scope counts to the affected tables and queries; other PGRST116 occurrences can
be unrelated. Do not use a production identity bypass or generate real sessions
to test access. Signed-in live login paths and post-deployment counts remain
unverified until that rollout step.

## Initial production observation

Read-only Supabase DEST edge-log aggregates used completed half-open UTC windows
on 2026-11-18. PGRST200 was scoped to tenant_membership requests containing
tenant_user_id; PGRST116 was scoped to tenant_user requests filtering identity_id.
Post-deployment failures also contained tenant_id filters.

| UTC window | REST requests | Scoped PGRST200 | Scoped PGRST116 |
| --- | ---: | ---: | ---: |
| 12:36–12:37, before promotion | 3,101 | 107 | 103 |
| 12:38–12:39 | 2,365 | 6 | 6 |
| 12:39–12:40 | 2,052 | 6 | 6 |

A further bounded check of 12:40–12:41 found five of each error, alongside 36
successful corrected membership reads and eight successful tenant-user reads.
Latest residual invalid relationship failure was 12:40:52.238 UTC.

The first comparison shows approximately 94% fewer targeted errors with active
traffic, but does NOT establish resolution. Successful and failing queries share
user-agent `node` and client-info `supabase-js-node/2.93.3`; logs contain no caller
origin/referrer or deployment marker. Residual traffic cannot be attributed to
old preview builds, old executions, another caller, or the promoted revision
from these logs. A source search found no remaining tenant_user_id relationship
embed in api/server/scripts. Independent caller attribution remains necessary.

No production writes, synthetic sessions or identity bypass were used.
Successful database requests do not verify signed-in member/admin/legacy login
or authorization behavior. Those live paths remain unverified; the 39 local
regression checks remain the access-policy evidence.

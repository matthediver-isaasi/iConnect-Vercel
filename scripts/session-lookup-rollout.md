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

## Caller attribution investigation

Both the production deployment above and latest preview
`dpl_73LzrMW5Fdb4kmhk6j9xcYv8xp6Q` were verified READY on branch `postreg`,
at the same corrected commit. There is no evidence implicating that preview.
Older production/preview deployments exist, but their existence is not evidence
of requests from them.

The Vercel deployment runtime-log endpoint provided live streams, not the
historical 12:38–12:41 UTC interval. The historical observability query returned
HTTP 403 Forbidden with the installed connector. The connection uses an API key
and does not support the inline reconnect flow. Better Stack exposed no relevant
application log source. Historical deployment/endpoint attribution is therefore
blocked by access to suitable logs, not established.

A further completed Supabase window, 12:49–12:50 UTC, contained 1,684 REST requests
and 12 of each scoped error. Residual traffic continues; neither zero errors nor
an old-preview cause has been demonstrated. Production data and configuration
were not changed during this investigation.

## Uploaded runtime evidence: separate development-domain deployment

The user's 50-line Vercel export for 12:38–12:50 UTC contained 48 entries from
the corrected production deployment and two preview entries from
`dpl_J3PsaKraFcztmRugb7zqCZXzzdZT`, serving `bnms.dev.iconn.app` on `gfitrain`
at 12:43:13.051 and 12:43:16.238 UTC. None of the 50 messages contains the
targeted session errors.

Authenticated Vercel metadata confirmed this separate READY deployment serves
commit `d0b5c9ffad51e00fb95eae1000d445358851b6b8` and holds aliases
`dev.iconn.app`, `*.dev.iconn.app`, and `gfi.dev.iconn.app`. Inspecting that
commit confirmed both old lookup patterns remain: the mandatory tenant_user
single-row query and the nonexistent tenant_membership tenant_user_id embed.
Those reads discard returned Supabase errors, explaining why an error/warning
export need not contain the underlying PostgREST failures.

This establishes an actively used deployment with the defective code, unlike
merely finding an old deployment in history. It does not directly correlate
individual Supabase failures to that deployment or prove it is the only caller.
Updating that development deployment to include the fix, then remeasuring, is
the next attribution test; no alias or deployment changes were made here.

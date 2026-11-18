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

Code is tested locally but not yet verified as deployed. No database migration
is required. The user must deploy through the normal Vercel process.

After deployment, verify the serving revision contains this change, then inspect
completed fixed UTC windows of Supabase errors. Historical baseline:
71,657 PGRST200 relationship failures over 2026-11-16 15:33 to
2026-11-17 15:33 UTC, with matching optional tenant-user PGRST116 responses.
Scope counts to the affected tables and queries; other PGRST116 occurrences can
be unrelated. Do not use a production identity bypass or generate real sessions
to test access. Signed-in live login paths and post-deployment counts remain
unverified until that rollout step.

# Opportunity owner identity compatibility

## Evidence and scope

On 2026-11-24, a read-only catalog inspection of destination Supabase project
`lvmzliemqnieeoruhkik` confirmed that `guard_opportunity_tenant_links()` accepts
`tenant_user` owners/collaborators only through the legacy `tenant_user` table.
The four enabled trigger attachments are on opportunity, activity, collaborator
and contact-role rows. The inspected function matches the pipeline source.
No customer sessions or customer data were queried.

The API previously made the same assumption. A unified admin with an active
qualifying tenant membership, an identity row and **no legacy user row** is the
reproduced failing fixture. Its customer organisation and optional contact are
valid. This verifies the code-path defect, **not** the exact identity or state
of the reported GFI session, which has not been inspected.

The fix retains `tenant_user:<stored UUID>` and `member:<stored UUID>`.
It does not link by email, create legacy users, rewrite sessions/ownership,
or treat customer contacts as staff. Unified staff IDs require both an identity
row and at least one membership in the selected tenant with status `active`
and role `owner`/`admin` or membership type `owner`, matching session resolution.
Duplicate memberships do not remove a valid qualifying membership.
Legacy-user and member validation remain unchanged.

The same resolution is used for owner/assignee validation, owner display and
quote sender identity lookup. Opportunity access, authenticated sender default,
eligible owner/collaborator membership, member primary-organisation restriction,
and final sender envelope rules remain unchanged. Collaborator discovery and
interactive addition remain member-only; the SQL patch supports the existing
historical `tenant_user` collaborator form without widening the UI.

## Prepared, not installed

Only forward migration
`supabase/migrations/202701240001_opportunity_owner_identity.sql` is needed.
It replaces exactly two principal subqueries in the existing guard. It does
not recreate triggers, change grants, rewrite data or alter other tenant,
contact, organisation, activity or stage checks. It refuses already-patched
or unexpected principal subqueries instead of silently replaying them.

**Do not replay `20260908_opportunity_pipeline.sql`, run the migration directory,
or add this migration to startup/post-merge hooks.** The historical pipeline
is used only to construct disposable test databases and compare the inspected
function contract.

No production migration, rollback rehearsal, customer write, email, payment,
contact correction or application deployment was performed for this change.
The migration requires separate approval before installation. Releasing only
the API code will not repair the deployed database check.

## Destination-pinned procedure

1. Offline review (no credentials or connections):
   `node scripts/rehearse-opportunity-owner-identity.mjs`
   prints the migration SHA-256. Review that exact file and retain the hash.
2. With approval for a read-only preflight, run:
   `node scripts/rehearse-opportunity-owner-identity.mjs --preflight --review-sha256=<reviewed hash>`
   It accepts only securely configured DEST credentials pinned to the destination
   project, uses validated TLS, verifies the complete baseline guard and four
   enabled trigger attachments, and rolls back its read-only transaction.
3. A separately approved schema-only rehearsal can use `--rehearse` with the
   same hash. It changes the guard inside a transaction, compares the full
   expected function, preserves function metadata/grants/trigger attachments,
   rolls back, and then verifies the original definition was restored.
   It inserts no customer fixtures and always rolls back. It is still a
   production DDL operation and must not run without approval.
4. After explicit installation approval, use the project's approved destination
   migration access to apply **only** the reviewed forward file atomically.
   Recheck the complete baseline immediately before application, not just the
   two substrings. Preserve a copy of the original guard and attachments as
   rollback evidence. Do not substitute SOURCE, DEV or the preview database if
   destination access fails. The rehearsal runner intentionally has **no apply
   or commit mode**.
5. Run the same runner with `--verify` and the reviewed hash after installation.
   It checks the exact expected guard and enabled trigger attachments under a
   read-only transaction; it does not create an opportunity or send a quote.
   Merge/release matching application code separately.

Signed-in GFI browser verification remains separate and would require an
authorised test account and separately agreed write scope. Do not test with
the reported customer organisation automatically.

## Regression verification

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  api/opportunities/index.test.mjs api/opportunities/detail.test.mjs \
  api/_lib/salesPrincipals.test.mjs api/_lib/opportunityRules.test.mjs \
  api/_lib/opportunityCollaborators.test.mjs api/_lib/salesQuoteSenders.test.mjs \
  api/_lib/opportunityPipelineMigration.postgres.test.mjs \
  api/_lib/sessionPromotion.test.mjs api/_lib/sessionLookup.continuity.test.mjs \
  api/_lib/salesFoundation.test.mjs
```

The isolated fixtures cover default authenticated ownership with/without a
contact, legacy/member/unified users, owner updates, task assignees, readable
named owners, sender identity/envelope behavior, duplicate memberships,
foreign/inactive/non-admin/missing identities and database errors.
The disposable PostgreSQL cluster reproduces the old rejection, exercises
the real forward guard and service role, checks preserved unrelated links,
and verifies schema rehearsal rollback. No configured external database or
provider is used by those tests.

### Results recorded on 2026-11-24

- Sales foundation/tenancy group: 51 passed, including the new API, owner
  resolution and disposable SQL guard/rehearsal tests.
- Quote delivery/public acceptance group: 27 passed, including sender controls.
- Session promotion/continuity: 13 passed.
- The broader Sales hardening command passed groups 1–5, then stopped in the
  accounting group: 77 passed and six Xero provider-readback fixture tests failed
  with `XERO_RATE_COORDINATION_UNAVAILABLE`. This change does not modify Xero
  accounting or its rate-coordination fixtures. Groups 7–8 were not reached.
- Application startup served port 5000. The unauthenticated browser preview of
  `/sales/opportunities` showed the existing `Tenant not found` error for its
  default GSF configuration. The signed-in UI was not verified.

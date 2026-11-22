# Member lifecycle implementation status

## Not complete or release-ready

The accepted Auto Archive task is **still in progress**. The current implementation
includes configuration, previews, non-destructive review decisions and access safeguards. It must not be
described as working automatic archiving or as completed member lifecycle
management. Do not enable processing, apply the migration, seed a live tenant's
settings or deploy as a completed feature without further work and approval.

No live database, tenant configuration, member data or provider was changed.

## Implemented preparation

- Pure tenant-independent policy validator and lifecycle evaluator.
- Calendar retention boundaries, timezone handling, dynamic role mapping and
  fail-closed missing-history/activity handling.
- Separate proposed archive and deletion-review actions; evaluator cannot return
  automatic minimisation or deletion.
- `/MemberLifecycle` configuration/read-only-preview interface, with prominent
  preparation-only status and disabled execution.
- Server-side existing RBAC checks, member-specific exclusions, explicit
  tenant-user administrator bypass and server-owned tenant/actor identity.
- Service-only preparatory schema, default-denied capability seeding, optimistic
  policy revisions, immutable-to-service-role policy audit and actor/tenant-bound
  paginated preview records.
- Database CHECK constraint prevents enabling this preparatory policy. There is
  deliberately no activation or member mutation function.
- Unsupported archive/restore, approval and disposal endpoints fail explicitly with 409.
- Initial read-only membership adapter protects current/future/pending entitlements,
  rejects missing dates and exposes existing expiry access-policy conflicts.
- Read-only CPD evidence uses effective ownership after merges, original occurrence
  dates, linked reversals and exact-decimal corrections. Missing occurrence dates
  remain explicit uncertainty; display/import timestamps are never substituted.
- Genuine password, Google, mobile and password-setup logins explicitly finalize
  evidence after session access revalidation. Refresh, tenant switch, portal SSO
  projection, masquerade and team logins do not opt in. A prepared service-only
  trigger records minimal forward evidence atomically with finalization and
  retains it after session expiry. This migration has not been applied.
- Scoped review queues and member evidence/audit endpoints with retain/release,
  dated retention extensions and exemptions, optimistic revisions and immutable
  decision history. Extensions cannot shorten an existing review date.
- Explicit administrator provenance for absent historical membership and
  historical login coverage. Existing membership rows cannot be overridden;
  failed source reads and known obligations still block transitions.
- Attendance evidence from current QR check-ins/reversals and matched provider
  outcomes with actual participant interval timestamps. Purchaser IDs alone
  cannot establish attendee identity.
- Outstanding obligation checks for recorded invoices, membership settlements,
  booking work, future events, form payments/refunds and unspent member credits.
- Prepared lifecycle access projection and independent session generation.
  Archived portal sessions are blocked, separate team access is preserved,
  and restoring a record cannot resurrect pre-archive member sessions.

## Remaining implementation

1. Verify cross-source coverage and historical provenance against representative
   fixtures, including complex-event legacy layouts and organisation entitlement.
   Credential `last_login` and member `last_activity` remain non-authoritative.
2. Complete installed-schema and source-generation guarantees for evidence
   reads; read-only results are not transactionally locked execution authority.
3. Finish field-level privacy/retention policy and disposal planning. Existing
   non-destructive retention holds do not authorize erasure.
4. Add lifecycle state, holds, extensions, exemptions, review/audit and operation
   storage with atomic execution and shared concurrency boundaries against
   renewals, payments, new activity and role changes. Preview reads alone cannot
   authorise execution.
5. Coordinate with the existing annual expiry sweep and role-event delivery.
   Both already mutate roles/access; do not independently run competing policies.
6. Implement version-bound complete-preview approval, daily fair/resumable
   processing, pause fences and deduplicated authorised-reviewer notifications.
7. Finish archive visibility across operational lists/counts/exports,
   directory/search and campaign preparation/send-time eligibility. The member
   authentication/session projection is implemented, with separate team access
   preserved; operational surfaces still require integration.
8. Implement archive/restore, field-level impact previews and confirmed minimisation/
   deletion with scoped retention plans and recoverable partial outcomes.
   Do not call the existing wholesale anonymisation helper for archive.
9. Verify renewal/activity/hold races, failures/retries, historical preservation,
   real browser interaction and installed-schema rollout before declaring the
   accepted task complete.

## Known preparation limitations

The evidence adapter reports failed, ambiguous and missing-date sources explicitly.
Historical login coverage requires an authorised documented review rather than
assuming complete past capture. Tests of future archive/disposal UI use fixtures
and do not prove backend execution exists.
CPD evidence now reads the complete effective ledger, but awards without reliable
occurrence dates still hold for review. These multi-request reads are preview-only,
not transactional authority to execute a lifecycle transition.
Forward login observations likewise remain incomplete evidence until historical
coverage and interrupted-capture handling are resolved. Before its migration is
installed, login finalization stores only a session marker; do not infer durable
coverage from those expiring sessions. After installation, evidence-storage
failure prevents issuing the new session instead of silently losing the event.
Existing sessions and non-login session operations do not require a new event.

Preview rows currently scan directly tenant-owned member records. Legacy
organisation-derived tenant ownership must be resolved before complete population
coverage can be claimed. A complete paginated preparation preview is not a
transactionally frozen population snapshot and cannot be approved for execution.
Review detail and decisions resolve both direct and organisation-derived tenant
ownership; this does not yet correct the preview population scan.

The UI is not automatically inserted into tenant menus. The page and RBAC
hierarchy are registered, but existing live roles and navigation are untouched.

The application production build passed. The preview server restarted cleanly;
the unauthenticated `/MemberLifecycle` screenshot stopped at the existing
workspace “Tenant not found” gate. Signed-in tenant UI was not verified. Mounted
UI tests use fixtures and are not live-tenant or provider verification.

## Verification commands

```sh
node scripts/run-isolated-tests.mjs node --no-experimental-global-navigator --import tsx --test \
  shared/memberLifecyclePolicy.test.mjs \
  api/_lib/memberLifecycleEvidence.test.mjs \
  api/_lib/memberLifecycleCpdEvidence.test.mjs \
  api/_lib/memberLoginEvidence.test.mjs \
  api/admin/member-lifecycle.test.mjs \
  client/src/components/member-lifecycle/MemberLifecycle.mounted.test.mjs
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  supabase/migrations/memberLifecyclePreparation.test.mjs
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  supabase/migrations/memberLifecycleLoginEvidence.test.mjs
node scripts/run-isolated-tests.mjs node --import tsx --test client/src/lib/roleAccessMap.test.ts
npm run build
```

The migration runner `node scripts/apply-member-lifecycle-preparation.mjs` defaults
to an offline hash-only dry run covering configuration and forward-login migrations.
Its explicit apply mode is pinned to the existing
external DEST database with verified TLS. No apply was run. This preparatory
migration is not a substitute for the remaining runtime migration and should
not be applied as a completed feature rollout.

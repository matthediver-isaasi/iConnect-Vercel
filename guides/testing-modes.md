# Testing modes

The application startup, local regression suites, and production verification
are deliberately separate operations.

## Application startup

Use the normal development command or the **Start application** workflow. App
startup serves the application only; it does not run regression suites or
connect to production for verification.

## 1. Isolated logic and regression tests

Regression workflows run through `scripts/run-regression-suite.mjs`. That
runner applies the test network boundary before starting a suite. Use these
workflows for repeatable code regressions; they are not production smoke tests.

| Command | Coverage |
| --- | --- |
| `npm test` | Existing client and shared logic regressions |
| `npm run test:ai-assistant` | Existing API/helper, AI, dashboard and Canvas regressions, including disposable DB tests |
| `npm run test:form-processing` | Form processor fixtures, workflow dispatch, authorization, ordering and retries |
| `npm run test:stripe-address-mappings` | Address mappings and related form/payment regressions |
| `npm run test:monthly-membership-activation` | Mocked monthly provider and activation paths |
| `npm run test:department-current-set` | Current-set logic and disposable DB regressions |
| `npm run test:rolling-memberships` | Rolling membership mocks and disposable PostgreSQL |
| `npm run test:safety-boundaries` | Startup separation, caught network attempts, child inheritance and production-mode safeguards |

To run a selected logic test:

```sh
node scripts/run-isolated-tests.mjs node --test api/forms/processApplicationOrganizationName.test.mjs
```

The boundary blocks unexpected fetch, HTTP(S), TCP/TLS, UDP and unapproved
child-process traffic even when real credentials are present. A blocked attempt
is a test failure even if application error handling catches it. Tests must
provide controlled dependencies; the form processor defaults still point to
the real workflow and guest-notification functions in the running application.
Do not replace fake tenant IDs with real UUIDs to make a blocked request succeed.

This is regression protection for trusted test code, not a security sandbox for
hostile JavaScript or arbitrary native addons. It does not prove deployed
permissions, schema compatibility, real provider behavior or end-to-end delivery.
Browser harnesses are separate: a browser is not protected by a Node fetch mock.
Legacy commands elsewhere in this repository are not automatically certified
safe merely because their names contain “test”. Use the guarded entry points.

### Unknown-page homepage fallback

Run the route policy, HTTP/prerender handlers, and settings authorization checks
without connecting to application databases:

```sh
node scripts/run-isolated-tests.mjs node --test api/_lib/unknownPagePolicy.test.mjs api/_lib/unknownPageIntegration.test.mjs api/redirects/settings.test.mjs
npx playwright test --config=tests/task-4634-unknown-page.config.mjs
npx playwright test --config=tests/task-4634-redirect-settings.config.mjs
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test supabase/migrations/redirectMappingTenantScopeMigration.test.mjs
```

The browser suite bundles actual routing components with in-memory dependencies
and intercepts all requests. Registered route leaves are stubbed: those checks
prove routing precedence, not event/article content rendering. The handler tests
exercise direct HTML, crawler and resolver decisions with controlled tenant data.
Neither suite enables the fallback or edits redirect rules on a live tenant.
The fallback defaults off; existing prefix/regex mappings remain unchanged.
The separate settings browser suite uses the real switch and project CSS,
covering load/save failures, toggling, persistence, and broad-rule warnings.
The disposable SQL check covers legacy redirect ownership adoption and
tenant-isolated operations. The tracked compatibility migration
`20261120_redirect_mapping_tenant_scope.sql` does not infer ownership for old
unscoped rows; those remain excluded from tenant-scoped reads. The destination
schema was verified read-only to already have the column, foreign key and
indexes, so no production migration was applied for this feature.

## 2. Disposable-database integration tests

These create their own temporary PostgreSQL cluster, apply fixture schemas,
test real SQL behavior, then stop and remove the cluster. They do not target
the application's configured database. The relevant named suites explicitly
enable this mode; ordinary logic tests do not.

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres \
  node --test api/_lib/rollingMembershipCommitment.postgres.test.mjs
```

The opt-in permits only scoped local PostgreSQL tooling and temporary UNIX
sockets, not unrestricted localhost TCP or a proxy to production. Missing local
tools or a blocked connection is not permission to fall back to `DEST_*`,
`SOURCE_*`, or `DATABASE_URL`. Temporary SQL writes are useful for constraints,
locking and idempotency coverage; they do not establish production schema or
data health.

## 3. Explicit production relationship smoke check

`npm run verify:production:relationships` is a manual, read-only check of the
Custom Object relationship-list functions in the production destination. It
has no implicit opt-in values and refuses to connect unless all of these are
provided:

```sh
ICONNECT_PRODUCTION_READ_ONLY_VERIFY=custom-object-relationship-list \
ICONNECT_PRODUCTION_VERIFY_TENANT_ID=<real-production-tenant-uuid> \
npm run verify:production:relationships
```

Before invoking it, confirm that the securely configured `DEST_SUPABASE_URL`
and `DEST_DATABASE_URL` identify the documented destination project
`lvmzliemqnieeoruhkik`. Do not paste credentials into commands or logs.
Choose the real tenant UUID deliberately; a syntactically valid UUID alone is
not sufficient—the script verifies that the tenant exists and has linked data.

Safety properties:

- The opt-in, explicit tenant UUID, Supabase origin, and PostgreSQL project
  identity are validated before a database client is constructed or connected.
- Candidate data is restricted to the supplied tenant in SQL.
- One PostgreSQL connection is used for every check.
- PostgreSQL enforces `BEGIN READ ONLY`; the script confirms
  `transaction_read_only=on` before reading tenant data.
- Every SQL statement and relationship-list function call goes through an
  audited adapter that accepts only the exact reviewed operation labels and
  statement shapes in the script. Stacked statements, write-capable commands,
  `SELECT ... INTO`, and unreviewed `SELECT` functions are rejected.
- The only invoked application functions are
  `custom_object_record_relationship_list` and
  `custom_object_record_relationship_projection`. The script also verifies
  their service-role-only grants and fixed `search_path`.
- The transaction is always rolled back and no provider APIs are called.
- PostgreSQL TLS certificate validation is enabled; arbitrary hosts cannot
  borrow the expected pooler username to pass the target guard.

Limitations:

- This verifies the deployed PostgreSQL relationship-list functions and their
  meaningful filtering, bounded projection, count sorting, and out-of-range
  count behavior. It does not make HTTP requests through PostgREST or execute
  the full `createCustomObjectService` path, because those would use separate
  connections outside the database-enforced read-only transaction.
- A production tenant must already contain an active linked Custom Object pair.
  The script never creates fixture data.
- Read-only queries can still place load on production. Run this check
  intentionally and only against the tenant being investigated.

## Write authorization and operational boundaries

Starting tests, clicking Run, supplying credentials, or enabling this read-only
check does **not** authorize production writes, migrations, messages, payments
or accounting effects. No write-capable production test is provided here.
A future one requires a separate explicit opt-in, reviewed operation allowlist,
defined tenant/record scope, idempotency and cleanup/compensation safeguards,
and independent approval. A GET request or a SQL SELECT is not by itself proof
that an operation cannot cause side effects.

Existing deployment and post-merge hooks are unchanged by this work; they are
not test commands and have their own operational effects and authorization.

## Evidence and troubleshooting

- **Test reports an isolation failure after assertions pass:** an application
  catch block swallowed a network error. Fix the missing injected dependency;
  do not suppress the boundary failure.
- **Production opt-in or destination rejected:** check the intended mode and
  destination configuration without printing credentials. Never weaken the
  target check or enable live access for fake fixtures.
- **No suitable production pair:** choose another authorized tenant with real
  linked data; do not create fixtures in production.
- **Scope of the incident:** the local fixture escape path explains how a
  mocked processor could call an independently configured workflow client.
  It does not identify the source of the request logged at
  2026-09-18 05:36:07 UTC. The saved local run ended around 01:52 UTC.
  No claim is made that other workspaces have been identified or stopped,
  or that historical production effects have been assessed.

## Verification record — 2026-09-18

The guarded checks below were run with the workspace credentials still
available; they did not grant network access to the fixtures.

| Check | Result |
| --- | --- |
| Form processing | 263 passed |
| Startup/network/production-mode safety checks | 17 passed |
| Stripe address mappings | 498 backend/SQL checks and 34 client checks passed |
| Monthly membership activation | 347 passed |
| Department current-set | 170 backend/SQL checks and 12 client/adapter checks passed |
| Rolling memberships | 560 passed |
| Existing general client suite | 438 passed, 2 unchanged source-assertion failures |
| Existing broad API/AI suite | 3,872 passed, 14 failures: 9 unchanged source assertions and 5 legacy fixture boundary failures |
| Production relationship smoke check | Not run against production; opt-in, target identity, read-only operations, rollback and rejection paths tested with controlled clients |
| Application startup | Server starts on port 5000 without starting test workflows |

The remaining client failures are the monthly-confirmation source assertion in
`client/src/lib/formPaymentQuote.test.mjs` and missing reserved gallery/footer
route names in `client/src/lib/reservedPageSlug.test.mjs`.
The broad API/AI suite's unchanged source assertions concern generic Custom
Object presentation, form route/payment policy markers, workflow delivery
ordering/error markers, and the embedded form submission source marker.
The boundary failures expose legacy dependencies in
`cpdCertificateAccess.test.mjs`, `customObjectRoute.test.mjs`,
`formRelationshipRoutes.test.mjs`, `formSubmissionEmails.guard.test.mjs`, and
`memberAiStructuredSchemaDrift.test.mjs` under `api/_lib/`. Their outbound
requests were blocked; these suites have not been removed or marked passing.

The local preview also reports `Tenant not found` for its existing `gsf`
configuration. This work does not change the application's database target or
claim that the public home page was verified successfully. No production
repair, migration, live email, payment or accounting verification was performed.
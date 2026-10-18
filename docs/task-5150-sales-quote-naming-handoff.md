# Task 5150 — schema-before-code handoff (PENDING)

No live database apply or deployment is authorized or performed by this naming task.
Do not mark the task complete on the strength of offline/disposable tests.
The merged catalogue task's `docs/sales-catalogue-visibility-rollout.md` reports
its visibility/atomic-create migrations already applied to DEST. That report is
not authorization to apply this new naming migration. No live inspection or
application was performed while resolving the merge.

## Review and authorization

1. Review `supabase/migrations/202610180002_sales_quote_naming.sql` and
   `scripts/apply-sales-quote-naming.mjs`; independently approve the exact file hash.
   `node scripts/apply-sales-quote-naming.mjs --review` is offline, opens no
   connection, and prints the pinned hash. Any file change requires a fresh review
   and hash update, never a bypass.
2. Confirm destination project `lvmzliemqnieeoruhkik` and explicit apply authority.
   Workspace runtime may point to legacy SOURCE: it is **not** migration evidence.
   Runner accepts only `DEST_DATABASE_URL` plus `DEST_SUPABASE_URL`, never
   `DATABASE_URL`, runtime Supabase variables, or SOURCE. Credentials stay secret.
3. Confirm `202610180001_sales_catalogue_visibility.sql` and its task-list
   prerequisite `202610120004_sales_automatic_quote_task_lists.sql` are applied.
   The pending naming migration was moved after visibility during merge review;
   the never-applied `202610120005_sales_quote_naming.sql` must not be used.
   The runner pins both prerequisite files and reconstructs the visibility-extended
   settings RPC offline. It fails closed if the installed RPC differs from that
   reviewed latest predecessor (or the final naming extension), rather than
   overwriting a newer definition. Latest predecessor SHA-256:
   `c1891a3d63d0b0416089fd2840d641e2d57d883e407677d1482784ef4d152e93`.

## Authorized operator sequence — schema first

With approved, verified-TLS destination credentials, run only after approval:

```sh
node scripts/apply-sales-quote-naming.mjs --apply \
  --reviewed-sha256=bb404a63ae5964a9752d059cc799e065efa7a17384506be9c8919b2292501a7a \
  --confirm-destination=lvmzliemqnieeoruhkik
```

Certificate verification is mandatory. URL query parameters (including insecure
SSL overrides) are refused. Supply the trusted CA through the operator's standard
Node trust configuration if needed; never disable verification. Locks/timeouts
fail rather than waiting indefinitely. The runner wraps preflight, DDL, RPC
extension, and grants in one transaction, with rollback on failure. Rerun is
idempotent. It does not apply prerequisite migrations automatically.

Verify destination metadata: the three NOT NULL/default/check-constrained columns
`quote_singular_name`, `quote_plural_name`, `quote_url_segment`; service-only
`patch_sales_settings` execute privileges; unchanged automatic task destination
and processing RPC definitions. Confirm default values Quote/Quotes/quotes and
that pre-existing settings versions/task-list names and catalogue visibility
values are unchanged. Both `showInternalCode` and `showSku` must still accept
explicit false and reject non-boolean JSON, and must share the same optimistic
settings version/audit as the naming fields.

Only then deploy application code pointed to that same destination. Code selects
the new columns explicitly and must not deploy before schema (missing schema
surfaces an error, not a silent fallback). After schema-cache refresh, verify
authorized settings GET/PATCH, stale-version 409, Unicode label trimming,
reserved-slug 400, independent tenant names and settings access denial. Read-only
users must not PATCH. Preserve the operator's timestamp/hash/destination evidence
without including credentials or customer records.

## Scope and recovery

Defaults are independent of `quoteTaskListName` (still `Quote tasks`). No existing
project lists/cards, task sets, document snapshots, quote identifiers/prefixes,
sequence kinds, or public quote bearer routes are rewritten. Slugs are per tenant,
not globally unique. Labels count Unicode codepoints after trimming; slugs allow
only lowercase ASCII letters/digits/single interior hyphens, max 100, excluding
dashboard, pipeline, opportunities, catalogue, reports, settings, allocations,
products, bundles and tasks.

If code rollout fails, roll code back while retaining the additive schema and
compatible RPC. Do not drop columns or restore the old RPC over saved naming
settings. A schema/RPC change requires a separately reviewed forward migration.

## Offline/disposable verification

```sh
env -i PATH="$PATH" HOME="$HOME" node scripts/run-isolated-tests.mjs \
  node --test api/_lib/salesFoundation.test.mjs
env -i PATH="$PATH" HOME="$HOME" node --test api/_lib/salesQuoteNaming.postgres.test.mjs \
  api/_lib/salesTaskAutomation.postgres.test.mjs \
  api/_lib/salesCatalogueVisibility.postgres.test.mjs \
  scripts/apply-sales-quote-naming.test.mjs
```

The PostgreSQL suites create fresh local socket-only UTF-8 clusters and remove
them afterward. They never consume a live database URL. Coverage includes
first-insert and existing-row races, audit/version atomicity, grants and server
role checks, independent tenants, all reserved segments, Unicode limits and
trimming, preservation of prior settings/lists/cards, and unchanged acceptance
automation after applying the new migration. They apply the latest visibility
migration before naming and verify the entire expected RPC body, both visibility
branches and combined boolean/naming updates. Runner tests require no database.
Use a credential-free environment for all these commands. The existing isolation
wrapper's PostgreSQL mode previously timed out; a direct credential-free local
socket cluster is the supported verification boundary here, not live DB access.
API/contract tests use the shared `salesNaming.js` helper supplied with application
code; run them together with the final integration, not against a missing helper.

## Server direct-route protection and limits

`unknownPagePolicy.js` and `homepage.js` resolve the alias freshly from
tenant-scoped `sales_settings` at request time. Only `/sales/<current-slug>`,
`/sales/<current-slug>/new`, and `/sales/<current-slug>/<id>` are protected as
tenant alias routes, using the shared route-shape helper. Static `/sales/quotes`
and registered Sales destinations keep precedence and do not require a naming
lookup. Unknown aliases and deeper/invalid shapes remain missing; there is no
static `/sales/*` registration. The route-parity test explicitly exempts dynamic
Sales alias/wildcard client routes from the static server registry requirement.

Settings query failures, duplicate settings, and invalid saved slugs are errors,
not missing-route evidence. The HTTP policy keeps its existing no-store error
app shell rather than redirecting or claiming a 404 on lookup failure. An alias
does not emit a permanent redirect, even if homepage selection is invalid.
Changing the setting immediately removes protection from the old custom alias;
explicit tenant missing-page rules may then apply normally. No alias history or
automatic old-alias redirects are stored.

This is route-shape protection, not record existence or authorization. The ID
shape is the shared helper's alphanumeric/underscore/hyphen segment; quote lookup
and Sales permissions remain the application's responsibility. No public bearer
routes or APIs change. Homepage selection still accepts only a published public
or hybrid root CMS-page slug, never an application URL with slashes. Existing
homepage canonical redirects for unrelated CMS pages are unchanged.

Additional tests:

```sh
node --test api/_lib/unknownPagePolicy.test.mjs api/_lib/homepage.test.mjs
```

## Final workspace evidence (2026-10-18)

- `npm run build` passed (existing large-chunk/Browserslist warnings remain).
- Focused settings, shared naming, navigation, API, server route/homepage and
  migration-runner fixtures passed: 57 tests in the combined run.
- Mounted routing/readiness plus shared naming/navigation passed: 58 tests,
  including the real quote editor retaining unsaved notes through an in-session
  alias change. Query parameters, fragments, role failures, tenant/session
  switches and delayed/failed settings discovery are covered.
- Intercepted Chromium browser routing passed: both Proposal/Proposals and
  Sales Plan/Sales Plans, cold list/new/detail, refresh, back/forward, live
  rename and former-alias rejection. The browser route fixture uses the real
  Sales shell, router, session providers and settings hook, but substitutes
  lightweight destination workspaces. It does not mount the whole portal Layout.
- Settings-card mounted tests cover immediate shared-cache publication, current
  version reuse, preserved unrelated dirty fields, 409 recovery, permissions and
  tenant/member scope changes. Internal dialogs/reporting and existing quote
  layout tests passed separately; customer email previews and PDF filenames
  remain unchanged.
- New naming/task-automation disposable PostgreSQL and runner checks passed
  (17 tests). Existing foundation/allocation PostgreSQL tests passed separately
  in a credential-free environment (20 tests):
  `env -i PATH="$PATH" HOME="$HOME" node --test api/_lib/salesFoundation.postgres.test.mjs api/_lib/salesCommercialAllocation.postgres.test.mjs api/_lib/allocationInvitation.postgres.test.mjs`.
  These harnesses create only temporary socket-only local databases.
- The aggregate Sales hardening command did **not** pass under the isolation
  wrapper: the old PostgreSQL harness timed out with the wrapper's local-PG
  argument handling. The separate disposable run above passed. The remaining
  non-SQL groups produced 133 passing tests, but the accounting test file
  attempted an independent role-visibility network lookup, correctly blocked by
  the isolation boundary. This is not a passing full Sales hardening run; no
  real provider call was allowed to bypass that boundary.
- The app workflow starts on port 5000. The unauthenticated `/sales/settings`
  screenshot shows `Tenant not found` for this workspace's preview host, not the
  signed-in settings UI. Signed-in live UI, live tenant settings and production
  route handling were **not** verified. No live quote was sent.

Reproduce route fixtures:

```sh
node scripts/run-isolated-tests.mjs node --import tsx --test \
  client/src/pages/Sales.namingRoutes.test.jsx \
  client/src/pages/Sales.accessReadiness.test.jsx \
  client/src/lib/salesNavigation.test.mjs shared/salesNaming.test.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(command -v chromium) \
  node --test client/src/pages/Sales.namingRoutes.browser.test.mjs
```

The browser fixture intercepts every request and rejects unexpected traffic.
System Chromium was used because the downloaded browser lacks a system library
in this environment. This is fixture evidence, not tenant authentication.

### Verification after integrating the catalogue settings changes

The final integration uses the existing catalogue settings discovery and its
active-tenant/session-generation write guards. Naming, task-list and visibility
cards use one cache and one optimistic version; a naming save cannot reset
visibility flags or unrelated dirty fields.

- Merged foundation contract/API checks: 14 passed.
- Naming, task automation, incoming visibility PostgreSQL and reviewed runner:
  25 passed, with credential-free disposable databases and no skips.
- Mounted naming/readiness routes: 46 passed; intercepted route browser and
  real quote layout: 2 passed; internal dialog/reporting suites: 14 passed.
- Settings cards, canonical scope/tenant guards, automation and accounting
  panels: 30 passed. Existing catalogue visibility and product/bundle UI:
  51 passed (includes the 7 visibility settings cases).
- Shared naming/navigation plus server homepage/route policy: 35 passed.
- Production build passed again after reconciliation; warnings are unchanged.

These are separately run suites, not a deduplicated aggregate test count.
The aggregate hardening limitation and live-verification limits above still apply.

**Applied:** only to disposable local test databases. **Pending:** the forward
migration on verified DEST `lvmzliemqnieeoruhkik`, followed by the matching code
rollout and authenticated verification. **SOURCE/runtime legacy database:** not
modified. No deployment performed.

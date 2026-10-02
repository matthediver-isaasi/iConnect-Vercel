# Related-record report filters

## Department setup

Create a **new version-2 report** in the Department object's Reports screen.
Do not overwrite the existing Department/member report or implicitly upgrade
its version-1 definition.

1. Choose **Department** as the starting entity.
2. Keep the row entity at **Department**, with row path `[]` (no traversal).
3. Add a related-record filter. Its path is relative to each Department row,
   not to an Organisation or to a global Member list.
4. Choose the outward **Members** relationship path.
5. Choose **None match**.
6. Add a condition on the **relationship** boolean **Survey respondent**:
   **equals Yes**. Do not select a global Member field or a survey-submission
   field instead.
7. Add Department display columns and, optionally, a row-relative distinct
   Members count. Preview before saving a separately named report.

This means: include a Department if **no eligible linked Member occurrence has
its Department–Member designation set to true**. Departments with no members,
only false designations, or only unset designations are included. One true
designation excludes that Department even when other members are false/unset.
A shared Member's designation in a different Department does not exclude this
Department. This is designation reporting, not evidence of survey completion.

Multiple conditions in one filter must match the **same related record and
relationship occurrence**. Multiple filters combine with **AND**. A filter
without conditions checks relationship existence (**Any match**) or absence
(**None match**). Repair unavailable paths or fields explicitly; never remove
saved criteria silently.

## Read-only destination baseline

The preparation check used the verified destination project
`lvmzliemqnieeoruhkik`, provider CA, hostname verification, and explicit
`BEGIN READ ONLY` transactions. No SOURCE or generic database connection was
used; no settings, saved reports, records, or export jobs were changed.

Validated metadata:

- Active Department object: `cd1ebfd3-3e16-4091-be5a-99992d926f2f`
  (`org_department`).
- Active outward Members definition:
  `0fdede92-efa2-4d84-9b16-df1a88069486`, many-to-many.
- Relationship field: `edf1fbf8-76f7-4455-a7e2-f0f45db57b43`,
  key `survey_respondent`, type boolean, label **Survey respondent**.

The baseline scoped all reads to the object's tenant and active Department
records, unarchived edges, and same-tenant Member endpoints, excluding deleted
Member sentinel emails. No names, email values, or other personal data were
returned.

| Aggregate | Count |
| --- | ---: |
| Active Departments | 325 |
| Eligible active Department–Member edges | 450 |
| Distinct linked Members | 418 |
| True designation edges | 188 |
| False designation edges | 90 |
| Unset/null designation edges | 172 |
| Unsupported designation values | 0 |
| Departments with at least one designated responder | 181 |
| Departments with no designated responder | 144 |
| Departments with no eligible Members | 73 |
| Departments with Members but no designated responder | 71 |

These are preparation-time independent SQL reference counts, not proof that
the new report engine, UI, or export has been deployed. Live data may change;
the expected None-match total at this snapshot is **144 = 73 + 71**.

## Verification and rollout boundaries

- **Isolated tests** use disposable PostgreSQL and/or intercepted fixtures.
  They can establish predicate, pagination, authorization and export semantics,
  but do not demonstrate live deployment or a signed-in production browser.
- **Read-only live checks** establish destination metadata and aggregate
  reference counts only. They do not save or repair reports.
- The workspace preview normally targets legacy SOURCE. Do not migrate SOURCE
  to make the preview resemble production; do not treat a local screenshot as
  live DEST verification.
- Frontend/backend deployment and authenticated browser verification remain
  separate rollout steps. Production frontend deployment requires separate
  confirmation.
- Migration execution requires explicit approval after backend tests
  and exact SQL hash review (approval and application are recorded below).
  Only the new generic filter migration is in scope;
  historical report-seeding migrations and Department/member settings or
  business records must not be replayed or changed.

## Guarded migration runner

New migration: `supabase/migrations/20261011_custom_object_report_filters.sql`.
Its current status is **applied to verified DEST** after explicit authorization.
The runner never applies it by default:

```sh
# Offline SHA-256 review of the exact new migration bytes; no DB connection.
node scripts/apply-related-record-report-filters.mjs

# Explicit read-only verified DEST metadata and aggregate refresh.
node scripts/apply-related-record-report-filters.mjs --inspect

# ONLY after explicit post-test approval and review of the current dry-run hash:
node scripts/apply-related-record-report-filters.mjs --apply --review-sha256=<reviewed-sha256>
```

Use only privately configured `DEST_DATABASE_URL` and `DEST_SUPABASE_URL`.
The runner reuses the verified destination-target validator, pins the REST
origin and SQL host/database/project username independently, and downloads the
public Supabase CA while retaining certificate and hostname verification.
It does not fall back to `DATABASE_URL`, `SUPABASE_URL`, or SOURCE.

The hash covers the full file, including its outer transaction envelope.
For execution the runner removes only that validated envelope, keeping the
new migration and post-apply checks in one runner-owned transaction. It checks
the three new functions' fixed search path and service-only execute grants,
then invokes the new filtered-summary RPC with both no filters and the
Department None-match condition, comparing totals against independent live
reference counts before commit. A mismatch rolls back. It neither creates an
export job nor saves a report. PostgREST schema reload notification is delivered
only on successful commit.

Preparation verification: runner syntax check and offline guard assertions
passed (wrong hash, unsupported flag combinations, duplicate flags, missing
DEST configuration, transaction-envelope handling). The runner's `--inspect`
path returned the baseline above in a verified read-only transaction.
These checks do **not** constitute backend semantic test results or approval
to apply; those remain the backend/main worker's responsibility. Any SQL change
requires a fresh hash review.

## Applied migration and verification evidence

After the owning agent confirmed **177 isolated tests passed**, including
actual PostgreSQL tests of the new and legacy functions, it explicitly
authorized application of the final migration. The final SQL was reviewed and
the guarded runner committed exactly this one migration to destination
`lvmzliemqnieeoruhkik` on **2026-10-02**:

- Migration: `20261011_custom_object_report_filters.sql`.
- Reviewed full-file SHA-256:
  `c413a40f54ac7c28e28ec2225b28cce6f2fd5d7ff6ae7e68021643fef0bd9819`.
- Runner result: applied successfully; all precommit metadata, service-only
  function-contract, and independent Department total checks passed.
- No business-record/settings DML occurs in the reviewed migration. No
  historical seed migration was replayed, no saved report was overwritten, and
  no export job was created.
- **No outstanding feature migration remains for related-record report
  filters.** This is schema rollout, not frontend/backend application deployment.

Post-apply verification completed at **2026-10-02T07:22:01Z** in a separate
verified-TLS, repeatable-read, read-only DEST transaction:

| Predicate | Exact matching Departments | Cursor pages at size 17 / 50 / 200 |
| --- | ---: | --- |
| None match, relationship Survey respondent equals Yes | 144 | 9 / 3 / 1 |
| Any match, relationship Survey respondent equals Yes | 181 | 11 / 4 / 1 |

For each predicate and page size, full cursor traversal returned exactly the
independent SQL reference IDs in order, with no duplicates or omissions.
Offset paging returned the same complete IDs and exact global totals.
Midpoint cursor resumption was verified for multi-page sizes 17 and 50;
exhausted cursors returned no rows at every size. Cursor continuation used
`p_include_total=false`, matching the resumable-export call contract; global
totals were checked on initial/offset pages rather than on prefix-seek
continuations. These were direct read-only RPC checks, **not** live export-job
creation or a downloaded production CSV.

The sorted None-match reference ID list's SHA-256 (IDs not published) is
`ef315abffbbcfff1dcf2d285cd9aef363b2696000ffe4bf67a6bfaf53e089706`.
The new RPC with no filters matched the legacy summary RPC's full payload and
all **325** Department IDs. Aggregate reference counts remained those in the
baseline table.

The owning agent also reported that
`tests/related-record-report-filters.spec.mjs` passed actual builder
configuration/reload using browser fixtures. That is isolated browser
verification, not signed-in live verification. Its unauthenticated root
screenshot showed the existing **Tenant not found** page; authenticated live
UI was **not verified**. No application deployment was performed.
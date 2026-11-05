# CRM alphabet navigation

Organisations keep their 20-row name-ascending default. Members keep their
50-row newest-first default; the visible name-sort selector enables first-name
or last-name ascending navigation. Descending and non-name sorts do not request
metadata. Neither list uses alphabet buttons as filters.

## Database prerequisite

On 2026-11-05, after explicit owner approval for schema only, the migration
was applied to verified DEST (`lvmzliemqnieeoruhkik`). The transaction verified
service-only execution privileges. SOURCE was untouched and zero production
member/organisation records were changed. Application deployment remains
separate; this task does not publish the frontend.

`supabase/migrations/202611050001_crm_alphabet_metadata.sql` adds three private
functions. Only `crm_alphabet_metadata` is granted to `service_role`; browser
roles cannot invoke it. The authenticated page handler uses the same CRM feature
gate for ordinary and alphabet reads. Tenant identity comes from session context.

The runner is offline by default:

```
node scripts/apply-crm-alphabet-migration.mjs
node scripts/apply-crm-alphabet-migration.mjs --verify-target
node scripts/apply-crm-alphabet-migration.mjs --apply --review-sha256=<reviewed hash>
```

Application requires owner approval. The runner pins DEST's REST identity and
SQL connection identity, verifies TLS and schema prerequisites, then applies
DDL transactionally and verifies grants. Do not apply to SOURCE or change the
workspace's database configuration. No production record writes are required.

## Filter and order contract

Both page and metadata reads use the same JavaScript filter builders. Metadata
records their predicates rather than sending a second hand-maintained set of
filter definitions to the database. The private SQL compiler permits a finite
set of columns/operators, quotes values, and rejects arbitrary SQL. Member
boolean-default resolution, linked-field validation and department schema
validation happen before aggregation. Department membership is an indexed
database EXISTS query, not an enumeration of member IDs.

Preference joins become EXISTS/NOT EXISTS and count each entity once.
PostgREST left-embedded linked-organisation filters retain the existing page
semantics; this change does not repair those filters or other sort modes.

Offsets come from database ordering by the selected name column, then unique
ID, with nulls last. Case and accents are not reordered in JavaScript. Initials
are returned as contiguous runs: repeated labels can legitimately appear more
than once under the database collation. Numeric, symbol and unnamed runs are
explicit. A response is capped at 512 runs; more complex datasets return an
unavailable response and leave normal pagination usable, rather than truncating
navigation or returning all records.

## Client lifecycle

Metadata is cached by tenant/viewer/filter/sort, not page, layout, page size or
displayed columns. List invalidation expires metadata for all cached filters
in that viewer scope. Grouping uses the current page size and only combines
consecutive ASCII letters whose server offsets are contiguous.

Jumps use exact record IDs and wait for the requested, non-placeholder page.
Previously visited target pages are explicitly revalidated before focus, so
cache freshness does not substitute for a response after a concurrent change.
Search edits cancel immediately, before debounce. Sort/filter/view/manual-page
changes cancel pending intent. A missing target cancels selection and refreshes
metadata; it never scrolls to a substitute record.

## Verification

```
node scripts/run-isolated-tests.mjs node --test api/_lib/crmAlphabet.test.mjs api/_lib/memberListFilters.test.mjs api/admin/_test/crmAlphabetHandlers.test.mjs api/admin/members/paginated.perf.test.mjs api/admin/organizations/paginated.perf.test.mjs client/src/lib/crmAlphabet.test.mjs
node scripts/run-isolated-tests.mjs node --import tsx --test client/src/hooks/useCrmAlphabet.test.jsx
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test scripts/crm-alphabet.postgres.test.mjs
npx playwright test --config=client/src/tests/crm-alphabet.config.mjs
```

The PostgreSQL suite starts and removes its own socket-only temporary cluster;
it never connects to environment database URLs. It exercises 1,310 matching
rows, duplicate names/preferences, unusual initials, nulls, zero results,
core/custom/country/role/status/organisation/department predicates, exact offsets,
cross-tenant isolation and service-only grants. It compares against ordered
SQL selections, not an in-browser comparator. Response size is asserted below
16KB for the fixture; the indexed tenant/order plan is also exercised.

Browser tests use network fixtures with real application components, not live
member accounts. The workspace still points at the legacy SOURCE database;
unauthenticated preview capture does not verify the signed-in production UI.
These checks are not evidence of a public rollout.

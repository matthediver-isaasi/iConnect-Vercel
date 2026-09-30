# BNMS workforce CSV — direct Row → Department prepared import

This is a **new**, direct-model-only review package. It does not replace or
modify `scripts/bnms-workforce-import/`, whose historical artifacts remain
preserved and are not executable authority for this package.

## Approval boundary

The live metadata retirement was separately authorized and has been completed
by the main workflow. Preparation is authorized; destination installation,
invocation, importer installation, and bulk import are **not**. The CLI has no
apply mode and makes no network calls. It writes only a new local review
directory. No SQL is in a migration folder.

The current contract is pinned to destination `lvmzliemqnieeoruhkik`, tenant
`ff2df806-b321-4254-b651-3af11fccf1db`, Row
`bf123bdb-7227-4f45-b5f9-8344d0f65446`, Department
`cd1ebfd3-3e16-4091-be5a-99992d926f2f`, and direct relationship
`a422da51-6005-4831-a69e-bf284ff6f124`.

`Reporting_Year` is checked solely as part of the exact source parser. It is
not placed in Row data, provenance keys, or any survey/annual entity.
`row_name` must be archived before package generation and `staff_group` must
be the active Row primary display. No Surveys are created.

## Generate from the fresh state

After the metadata retirement, obtain two complete, matching, destination-only
GET snapshots using the existing pinned read-only transport. Save the second
snapshot and an observation object containing `project`, `completePasses: 2`,
`stableAcrossPasses: true`, `databaseWrites: 0`, matching `fingerprint`, and
both complete pagination ledgers. Then run:

```sh
node scripts/bnms-workforce-direct-import/prepare.mjs \
  /tmp/bnms-workforce-direct-state.json \
  /tmp/bnms-workforce-direct-observation.json \
  reports/bnms-workforce-direct-import-preparation-v3
```

The output directory must not already exist. The generated package contains a
compact manifest, review JSON/HTML, and review-only installation/invocation
SQL. It preserves all 1,242 physical source occurrences (132 repeats), exact
source-byte identity, canonical dropdown strings including trailing spaces,
blank legacy values as `No`, and omits `vacant_wte`.

## Future execution requirements (separate approval)

The prospective SQL is atomic, has table/advisory locks, checks that ordinary
triggers are not disabled, pins full metadata and the eight existing Row
baseline, and grants ledger/function access only to `service_role`. A final
approved operator must set transaction-local `bnms.final_import_approval` to
`<source SHA>:<manifest SHA>` before installing or invoking it. This is an
accident-prevention interlock, not authentication or evidence of approval.

The first run inserts 1,242 Rows and 1,242 direct Department edges plus
provenance. It refuses any unprovenanced Row overlap. Replays perform no repair
or creation and prove every occurrence, edge, and existing baseline record.
Repeat the GET audit and hash review immediately before any future approved
operation.

## Offline checks

```sh
node --test scripts/bnms-workforce-direct-import/*.test.mjs
```

These checks execute no SQL and make no database calls. They do not establish
live PostgreSQL syntax, permissions, trigger compatibility, locks, or rollback.

For an explicit, disposable local PostgreSQL runtime check (never a project
database and never automatic), run:

```sh
BNMS_RUN_LOCAL_POSTGRES=1 node --test \
  scripts/bnms-workforce-direct-import/postgres-runtime.test.mjs
```

It creates a temporary `/tmp` cluster and synthetic typed schema, seeds the
reviewed manifest through `jsonb_populate_record`, installs/invokes/replays the
generated SQL, and exercises foreign-key and rollback failures. This validates
scratch PostgreSQL behavior only; it is not destination execution and does not
establish production trigger, permission, or lock parity.
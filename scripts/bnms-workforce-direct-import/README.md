# BNMS workforce CSV — direct Row → Department prepared import

This is a **new**, direct-model-only review package. It does not replace or
modify `scripts/bnms-workforce-import/`, whose historical artifacts remain
preserved and are not executable authority for this package.

## Approval boundary

The CLI authorizes **preparation only**, not destination installation or
invocation. It has no apply mode and makes no network calls. It writes only
a new local review directory. No SQL is in a migration folder.

The owner separately approved the exact full-file import and preservation of
the eight existing rows on 2026-11-26. That operation has now been executed
and verified; see the execution record below. This is not standing approval
to reinstall the importer, change the manifest, or import another cohort.

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

## Approved execution — 2026-11-26

The newly supplied CSV matched the previously reviewed source byte-for-byte:

- Source SHA-256: `b0c618501cf5af9073d074d6e0474cd772b0978437b3fdab55ff1a66390bf746`.
- Approved manifest SHA-256: `61207ca26c2815d5b4a3f42ee4c09e995b619f480a8ee645bd680ab26cdfb126`.
- Destination and tenant: the pinned project and BNMS identifiers above.
- Installed and invoked atomically through the managed migration named
  `bnms_workforce_direct_import_approved_1242_rows`.
- Inserted 1,242 workforce rows and 1,242 direct Department links across
  136 Departments, representing 1,708.14 occupied WTE.
- Preserved all eight existing rows and their links, without modification.
  They belong to three different Departments outside the supplied CSV.
- Final active workforce: 1,250 rows and 1,713.74 occupied WTE.
- Retained every source occurrence; mapped the 53 blank legacy-vacancy
  answers to `No`; omitted reporting year and unprovided vacant WTE.

Before committing, the complete installation and import ran against the
destination's real schema and triggers in a deliberately rolled-back
transaction. Independent reads confirmed that the rehearsal left no importer,
provenance, rows, or audit events behind. The committed operation then passed
a GET-only, fully paginated proof of every occurrence, payload and direct
Department link, with the original records, links and metadata unchanged.

The final permission check also verified Supabase's broad default service-role
table grants. A separate, narrowly scoped permission update removes those
defaults from both provenance tables and grants service-role SELECT only.
The template and disposable PostgreSQL fixture enforce this explicitly.

Private execution evidence is retained under the ignored, deployment-excluded
`generated-artifacts/bnms-workforce-import-20261126/` directory. Do not replay
installation or regenerate a first-import manifest from the now-populated
destination; the sealed run and occurrence ledger are the execution authority.
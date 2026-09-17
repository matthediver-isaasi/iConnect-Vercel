# BNMS workforce CSV — staged import, not approved for execution

## Authority

The user explicitly approved:

- Keep all 1,242 CSV occurrences, including the 132 normalized repeats.
- Use the mappings in `reports/bnms-workforce-validation/report.html`.
- Preserve exact canonical dropdown values, including the four trailing spaces.
- Repeat the read-only destination GET audit.

They have **not approved** installing schema/function changes, invoking an import,
changing metadata, running SQL, or making test writes. Preparing these files is
not permission to execute them. No SQL has been executed for this preparation.

## Files

- `plan.mjs`: pinned source validation, canonical mapping, manifest creation,
  review SQL rendering, and independent offline replay verification.
- `prepare.mjs`: offline-only packaging CLI. No apply mode and no network calls.
- `import.sql.template`: new, parameterless atomic importer plus three dedicated
  provenance tables. This is deliberately **not** in `supabase/migrations/`.
- `plan.test.mjs`: pure JavaScript mapping and replay simulations.
- `sql-template.test.mjs`: SQL source inspection only, not database tests.
- `review-report.mjs`: self-contained human review report.
- `reports/bnms-workforce-import-preparation/`: reviewed generated package.

The old `scripts/import-workforce-survey.mjs` and its eight-row RPC are unchanged
and must not be used for this CSV.

## Preparation

The authorized re-audit used `workforce-readonly-state.mjs` GET-only transport,
two complete stable reads, and `workforce-csv-audit.mjs`. It did not overwrite the
earlier validation report. Both reads matched that earlier report's fingerprint.

The offline packaging command is:

```sh
node scripts/bnms-workforce-import/prepare.mjs \
  /tmp/bnms-workforce-preparation-state.json \
  /tmp/bnms-workforce-preparation-observation.json \
  reports/bnms-workforce-import-preparation
```

The temporary inputs are not committed; the package contains the scoped
metadata, source manifest, prior sample, and audit pagination evidence needed
for review. The command refuses to overwrite an existing output directory.
It verifies exact source bytes, all totals, active Departments, field and
relationship contracts, and absence of unprovenanced overlap. It only resolves
the known whitespace write-path blocker; other audit blockers still fail.

## Import design

One transaction inserts 136 surveys, 1,242 rows, and 1,378 edges, plus 1,379
provenance entries (one run, 136 surveys, and 1,242 occurrences). Normal database
triggers stay enabled. No existing record or metadata is changed.

Each occurrence has a relational primary key:
`(tenant_id, row_object_id, source_sha256, source_line)`.
The source hash covers the exact original file bytes, not a normalized export.
The secondary identity digest covers the same four values in the source audit's
JSON encoding. Record IDs and edge IDs are unique within each ledger.

The run ledger pins the complete manifest to the tenant and row object. Changed
files, reordered files, changed mappings, and changed metadata are not adopted.
After an import, use the original installed function and manifest for replay:
do not regenerate a first-import manifest from already-imported records.

The SQL takes a transaction-scoped advisory lock and table-level
`SHARE ROW EXCLUSIVE` locks before reading authoritative metadata or planning
inserts. This deliberately blocks concurrent writes to these tables, including
other tenants, while allowing ordinary reads. It is a one-off safety tradeoff,
not an online bulk-import architecture. Plan a quiet maintenance window.
Caller scripts set a 10-second lock timeout and 120-second statement timeout.
Actual trigger runtime and lock duration have not been measured.

The exact live option string is matched and stored without trimming.
Ambiguous mappings fail during preparation; unknown or drifted options fail
again under the transaction locks. `vacant_wte` remains absent. Requiredness,
types, text length, metadata, and relationship constraints are rechecked.

Replay verifies every row's exact data and occurrence identity, its exact survey
ledger parent, and the survey's exact Department edge. Missing, archived, changed,
partial, historical, additional, or ambiguous state raises an error; it never
silently repairs state. Original sample records and incident edges are checked
before and after; all new incident edges are counted and checked.

## Future execution checklist — requires separate final approval

1. Review the generated manifest, SQL, hashes, and human report. Record explicit
   final approval for schema installation and this exact import. If database
   integration tests are requested, obtain approval for their exact target and
   writes too; do not assume a rollback test is read-only.
2. Independently confirm destination **lvmzliemqnieeoruhkik** using the existing
   pinned GET client. Never use generic runtime `SUPABASE_URL`, `DATABASE_URL`,
   a legacy source database, or a guessed project.
3. Recheck the original CSV hash and all artifact hashes in `review.json`.
   Repeat the full read-only audit; stop for any drift. No automatic remapping.
4. Use an approved destination-only SQL connection with verified TLS. The
   installation file adds three ledger tables and one service-only function.
   Installation does not invoke the import. Both scripts are review-only and
   neither grants itself approval.
5. Only **after approval**, the operator may set the connection's
   `bnms.final_import_approval` session setting to
   `<exact CSV SHA>:<reviewed manifest SHA>` (both from the review package).
   The manifest file is compact JSON with no trailing newline; its exact file
   bytes are the SQL function's embedded manifest commitment. This prevents
   changed per-line payloads from being accepted under the same source hash.
   This string is an accident-prevention interlock, not authentication or proof
   that approval was received. Restrict execution with the database grants.
6. Install the reviewed SQL, then invoke the reviewed function using the
   invocation SQL's explicit transaction and timeout settings. Ensure the client
   stops on SQL errors, rolls back an aborted transaction, and clears/closes the
   approval-bearing session. Do not blindly retry an ambiguous network outcome.
7. Verify committed row/edge values and totals read-only. Invoke an unchanged-file
   replay only within approved scope; it must return 0 creates and 136 surveys,
   1,242 rows, and 1,378 edges reused. Sample totals remain 3/8/11.

The SQL uses strict full metadata snapshots (ignoring only metadata
`created_at`/`updated_at`). Unrelated relationship-definition changes within BNMS
can therefore require a new review. This is intentional fail-closed behavior.

## Verification

```sh
node --test scripts/workforce-csv-source.test.mjs \
  scripts/workforce-csv-audit.test.mjs scripts/workforce-readonly-state.test.mjs \
  scripts/validate-bnms-workforce-csv.test.mjs \
  scripts/bnms-workforce-import/*.test.mjs
```

These tests execute no database SQL. They do **not** establish SQL parse/runtime
compatibility, real trigger/permission behavior, transaction rollback, or live
concurrency performance. Those remain explicit pre-execution review/testing
limits; no claim of a successful live import is made.
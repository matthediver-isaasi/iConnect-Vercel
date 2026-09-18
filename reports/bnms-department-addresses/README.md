# BNMS Department address update — completed 18 September 2026

## Result

- Production project: `lvmzliemqnieeoruhkik` (DEST credentials only, certificate-verified TLS).
- Tenant: `ff2df806-b321-4254-b651-3af11fccf1db`.
- Department object: `cd1ebfd3-3e16-4091-be5a-99992d926f2f`.
- Workbook SHA-256: `acfc52ca8baf88c09ac76a688d05ba5c98ba1ee4b44ac766f8f900bd9b78225f`.
- 301 source rows, 298 distinct pairs, three identical repeat rows consolidated.
- **298 existing Departments updated; zero matched Departments already unchanged at apply.**
- 1,159 address/telephone values updated; 927 blank source cells preserved destination values.
- All 17 supplied telephone strings verified, including `0115 9691169 x55497`.
- The existing phone definition changed from `number` to `text`, preserving its UUID and configuration.
- No Departments, Organisations, or relationships created, deleted, renamed, archived, or re-parented.
- Names, region, other custom data, Organisation data, relationships, later duplicates and other tenants preserved.
- Fresh post-commit dry run: **298 unchanged, zero planned writes, zero unresolved exceptions**.

## Matching approval

Initial preflight stopped without writes on six ambiguous pairs. The user explicitly
approved the original 27 August records on 18 September 2026:

| Match | Selected existing UUID |
| --- | --- |
| Midland Metropolitan — Radiology based Nuclear Medicine (115/117) | `197b6854-fdc8-4ea0-b78d-e61d346bd1fc` |
| Royal United — Nuclear Medicine - Physics based (209/210) | `e2633069-3409-4146-b28c-148263acb7b3` |
| Scarborough — Nuclear Medicine Stand Alone (217/218) | `ad731b3d-c4bb-4f21-a58d-9ef85800a3ff` |
| University Hospital Coventry Organisation (269–271) | `bd2b845b-a8b7-49f8-ad1b-17c466c94f2f` |

These selections are pinned alongside the complete reviewed candidate sets in
`scripts/lib/bnms-department-address-approvals.mjs`. They are not aliases or fuzzy
matching rules. Later duplicates remain untouched.

## Evidence

- `completed-rows.csv`: final outcome and verified values for every source row.
- `completion-summary.json`: machine-readable totals and evidence paths.
- `matching-candidates.csv` and `match-exceptions.json`: initial duplicate evidence.
- `phone-audit.json`: initial read-only field dependency/value-shape audit.
- `2026-09-18T06-37-27.182Z-dry-run/dry-run.json`: clean approved preflight, all diffs.
- `2026-09-18T06-37-52.434Z-apply/before.json`: fsynced recoverable before-values.
- `2026-09-18T06-37-52.434Z-apply/verified-before-commit.json`: complete value comparison
  and before/after preservation fingerprints for all rows in the relevant tables.
- `2026-09-18T06-37-52.434Z-apply/committed.json`: committed update totals.
- `2026-09-18T06-39-14.776Z-dry-run/dry-run.json`: fresh independent zero-write rerun.

Earlier blocked dry-run reports are retained as historical evidence, not final results.

## Safety and recovery

The runner is dry-run by default. Apply requires an explicit clean preflight path,
an unchanged source digest, unchanged destination state/dependencies, the approved
resolutions, transaction-scoped advisory locks, serializable isolation, scoped row
locks, and full-row compare-and-swap updates. Existing custom-object update
validation receives current `existingData`. All updates and the field change
commit together only after value and preservation verification.

The before-value journal contains original rows and per-target `beforeData`,
`afterData`, changed keys, and the full original phone definition. Recovery is
deliberately not automatic: after separate authorization, restore only changed
keys whose current values still equal the recorded after-values, preserving
absent keys versus explicit nulls. Restore the phone definition only after checking
all current phone values/dependencies remain compatible with the original numeric
type. Never overwrite a later user's edit or disable production triggers.

## Isolated regression checks

```sh
node --test scripts/update-bnms-department-addresses.test.mjs \
  scripts/update-bnms-department-addresses-runner.test.mjs \
  scripts/bnms-department-phone-audit.test.mjs
```

24 tests passed. Tests use fixtures/mocked SQL clients and never write production.
No frontend or application runtime code changed.
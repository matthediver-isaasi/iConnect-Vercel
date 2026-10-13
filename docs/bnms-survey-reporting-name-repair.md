# BNMS Autumn Meeting Feedback reporting-name repair

## Applied

One-off **data repair**, applied to external Supabase **DEST**
`lvmzliemqnieeoruhkik`, for BNMS tenant
`ff2df806-b321-4254-b651-3af11fccf1db`, form
`a8610153-ab67-4fee-8941-54d2b725e252`.

- Current form: 19 score-field reporting names corrected.
- Published version 1 (`d920ed8c-271a-4bb5-a4b2-4275325b3d82`): 19 corrected.
- Published version 2 (`4e4a7d28-8177-4f94-8966-b38e8e4770ee`): 19 corrected.
- Total: **3 rows / 57 reporting-name values**.
- Includes the exhibition question's full label and the previously unnamed
  presenters-only reporting field. Each snapshot uses its **own** label verbatim.
- A second committed execution updated **zero rows**.
- SOURCE was not accessed. No schema migration or application deployment is
  required; no repair remains outstanding.

## Reproduction and recovery metadata

Runner: `scripts/repair-bnms-survey-reporting-names.mjs`.
Manifest: `scripts/data/bnms-survey-reporting-names.json`.

The manifest retains only field IDs, labels, original reporting-name
presence/values, desired values, row hashes and a deployed-protection hash.
It contains no respondents, submissions, free-text answers or credentials.
The original missing reporting-name property is distinguishable from a null.
Recovery would require a separately approved, equally guarded inverse repair;
do not change or regenerate the applied manifest to accommodate drift.

Commands executed, in order:

```sh
node scripts/repair-bnms-survey-reporting-names.mjs --audit
node --test scripts/repair-bnms-survey-reporting-names.test.mjs
node scripts/repair-bnms-survey-reporting-names.mjs --rehearse
node scripts/repair-bnms-survey-reporting-names.mjs --apply
```

`--audit` creates the manifest exclusively and refuses to overwrite it.
`--rehearse` executes the complete repair and verification, rolls back, and
checks that the original rows remain. `--apply` commits only after every
assertion passes, then executes the repair again and requires zero updates.
Subsequent legitimate edits will intentionally make the pinned runner fail
closed rather than rewrite newer metadata.

## Safety and verification

The runner verifies both REST and SQL destination identity using the existing
DEST-only verified-TLS connector. It pins form ownership, name, survey type,
snapshot identities and version numbers. Full-row hashes are checked under
locks before writes; only the `fields` column is updated.

Within a single transaction, ACCESS EXCLUSIVE locks on form and survey_version
prevent concurrent writes from observing the temporary exception. SHARE locks
on submissions and answers provide stable preservation comparisons.
Only the two named snapshot triggers are temporarily disabled; both are
restored before commit. No replication-role bypass, grants, functions, policies
or persistent exceptions are installed. Deployed trigger definitions, function
definitions, enablement, grants, column privileges and RLS policies are compared
before and after. Savepoint probes demonstrate that each original snapshot
guard independently rejects UPDATE after restoration.

Exact full-row equality against the intended transformation verifies field IDs,
array order, labels, non-score fields, scoring rules, version numbers, settings,
timestamps, and all other properties remain unchanged.

Database-side fingerprints verified preservation of:

| Protected data | Rows |
| --- | ---: |
| Other forms | 110 |
| Other survey snapshots | 8 |
| Target survey submissions | 28 |
| Target stored score answers | 521 |

No respondent records were logged or stored in evidence.

The runner executes the **existing** report metadata, aggregate, distribution
and export-sheet functions directly from `api/reports/survey-report.js` against
the destination's stored numeric data, before and after, for all versions,
version 1 and version 2 separately. Numeric question results and distributions
are compared by field ID, not alphabetical display order. Overall/category
results are also unchanged. Metadata, result labels, distribution labels and
the question rows shared by CSV/XLSX exports now use the correct labels.
No HTTP export was invoked, avoiding unrelated export-audit mutations.

Six regression tests passed, covering transformation boundaries, invalid shapes,
historical labels, idempotence, actual reporting functions, the pinned manifest
and the UI's label bindings for results/charts/distribution headings.

## Browser verification boundary

No frontend code changed. The signed-in report UI was **not visually verified**:
the local preview was unavailable (connection refused), and local runtime
configuration points at SOURCE rather than the repaired DEST database.
The verification above covers the existing reporting functions and UI bindings,
not authenticated browser rendering or a downloaded workbook.

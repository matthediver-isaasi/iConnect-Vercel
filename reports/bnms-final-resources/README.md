# BNMS final Resources — approved and verified

The user explicitly approved adding the four missing **Resource Type**
subcategories and importing all otherwise valid rows from
`Resources_-_categorising-tagging_FINALISED_1789486104337.xlsx`. The verified
execution package is:

`execution/2026-09-15T16-03-05.701Z/`

## Verified execution

| Result | Count |
| --- | ---: |
| Resources before | 2,878 |
| Inserted | 379 |
| Existing resources updated | 27 |
| Unchanged valid rows | 3 |
| Blocked/skipped source rows | 121 |
| Resource writes | 406 |
| Taxonomy category writes | 1 |
| Total transaction writes | 407 |
| Replay writes | 0 |
| Resources after | 3,257 |

The four additive Resource Type values were:

- `NM Images`
- `Patient Information leaflet`
- `Educational Resources`
- `Historical Resources`

No other taxonomy metadata changed. Existing tags, classifications, role
restrictions, status, display type, folders, links and other unrelated
resource fields were verified unchanged. The 14 proposed access changes
remained held and were not written. Four-digit year dates used the approved
January 1 convention. The source workbook contains 23 such year-only rows.

## Held rows

The 121 held rows remain untouched. They include:

- 91 rows missing Member Only, Collection and Resource Type values;
- 14 existing access-change rows held by explicit approval scope;
- 10 repeated/conflicting source-identity rows;
- 1 title-only candidate;
- 1 multiple-destination match; and
- 3 invalid resource URLs.

No rows were deleted and no unapproved taxonomy value was created.

## Evidence

- Workbook SHA-256:
  `0c408805b7dabb1ae84fb152de29043de8d3ebb045626f74fffb32d3b95e838e`
- Tenant:
  `ff2df806-b321-4254-b651-3af11fccf1db`
- DEST project:
  `lvmzliemqnieeoruhkik`
- `before.json` and `taxonomy-before.json` are immutable pre-write backups.
- `plan.json` records the approved scope and deterministic resource IDs.
- `expected.json` records the complete transaction target.
- `after.json` and `replay-after.json` are complete ordered REST snapshots.
- `execution-report.xlsx` contains final counts, every source-row action and
  all skipped rows/reasons.
- `verification.json` records stable paginated reads, field-preservation
  checks, taxonomy preservation and zero-DML replay.

The transaction used an advisory transaction lock, table locks, exact
before-state guards and rollback-on-error. The second invocation found the
expected final state and rolled back without DML. Focused tests passed:

`node --test scripts/bnms-final-resources-proposal.test.mjs scripts/apply-bnms-final-resources.test.mjs`

The runner remains available for an explicit read-only plan:

`node scripts/apply-bnms-final-resources.mjs --dry-run`

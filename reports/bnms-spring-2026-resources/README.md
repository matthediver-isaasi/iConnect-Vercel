# BNMS Spring Meeting 2026 — execution outcome

Production destination: `lvmzliemqnieeoruhkik`, BNMS tenant
`ff2df806-b321-4254-b651-3af11fccf1db`.

Source SHA-256:
`db61ce39f47baec8a8bb48bc2c8a0a40081163193e139b816e0e6300d3b5c1e0`.
The Resources worksheet contains 308 populated rows: 173 Presentation and
135 Posters. Lists and trailing empty rows were not imported.

## Actual first-execution totals

| Outcome | Source rows |
| --- | ---: |
| Updated | 161 |
| Inserted | 12 |
| Unchanged | 0 |
| Blocked, not written | 135 |
| Total | 308 |

The 173 successfully applied rows are members-only (`is_public=false`) and
use Download (`resource_type=download`). Existing role restrictions, tags,
unrelated metadata and classifications were preserved. Blank source dates
did not erase existing release dates. No taxonomy values were created.
No title-only match was used to update a resource.

**This is not a claim that all 308 resources are now members-only.** Blocked
rows were left untouched, including their existing access settings.

## Unresolved rows

- 125 rows have title-only candidates with different resource identities.
  Explicit identity review is required; no records were inserted around them.
- 2 rows (42, 48) have multiple destination matches.
- 8 rows (2, 3, 4, 5, 68, 69, 126, 144) use Highlights, which is absent from
  the verified Focus Area taxonomy.
- Row 45 also has an invalid `ttps://` resource URL. It is included in the
  title-only count above, not an additional blocked row.

Every unresolved source row and candidate ID is recorded in the proposal
audit and the execution workbook. Page URL and Menu Item remain provenance
only; no mapping was inferred for them.

## Verification and audit evidence

- Ordered, exact-count-checked destination reads covered 3,257 resources
  before and 3,269 after, across seven pages; all six taxonomy rows were read.
- Atomic SQL drift checks and complete before/after comparison confirmed
  only the planned changes. Existing ambiguous duplicates were not merged
  or deleted; inserts had no URL, Drive identity or title-only candidates.
- All 173 affected records pass the existing locked public projection,
  which suppresses their target URL. Permitted-member visibility checks
  passed for all 173. These are authorization-helper checks against actual
  after-records, not a claim of a logged-in production browser test.
- 61 focused import and authorization tests passed.
- Post-apply comparison: **0 inserts, 0 updates, 173 unchanged, 135 blocked**.
- A second application returned `already_applied`, with **0 writes**.

Proposal and row-level blockers:
`2026-09-15T16-46-19.783Z/`.

First execution, durable before/after records, plan, transaction journal,
verification and downloadable execution report:
`execution/2026-09-15T16-46-42.963Z/`.

Zero-write application replay:
`execution/2026-09-15T16-48-12.647Z/`.

Read-only repeat comparison:

```sh
node scripts/apply-bnms-spring-2026-resources.mjs --dry-run
```
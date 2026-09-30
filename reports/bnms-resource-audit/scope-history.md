# BNMS resource audit: surviving scope and history

## Method and boundary

This is a read-only reconstruction from files, git history, local task text and
saved reports. No import/apply runner was invoked, no database was accessed, and
no current-production conclusion is made here. The scope is the surviving
uploads used to create or classify BNMS resources. Generic Base44 exports and
unlinked content documents are listed as exclusions in `scope-evidence.json`.

The audited upload window is **27 May–15 September 2026**. September is the
best-evidenced cluster; the May, June and July files are included because the
September tasks and scripts explicitly continue those earlier imports.

## Upload lineage

| Date (git UTC) | Upload | Parsed scope | Intent and surviving evidence |
| --- | --- | ---: | --- |
| 2026-05-27 | `BNMSResourcesClean_1779888089327.csv` | 29 data records | Initial external-link import. Task says “61 rows + header”, but the surviving BOM CSV parses to 29 records; physical line count is inflated by quoted newlines. Import-named commit exists, but no durable report/journal survives. |
| 2026-06-03 | `bnms-resources2_1780477749303.csv` | 921 | Poster batch import. Import-named commits and runner survive; no durable execution report. |
| 2026-06-03 | `bnms-resources3_1780478750493.csv` | 921 | Exact byte-for-byte duplicate/revision of resources2 (same SHA-256); it is one expectation set, not another 921 rows. |
| 2026-06-03 | `BNMS-batch3-correct_1780479260692.csv` | 335 parsed, task says ~194 real videos | Corrected YouTube batch. Task records 141 blank separators. Import-named commit survives; no row journal. |
| 2026-07-02 | `Spring_Meeting_2026_resources_1782996382352.xlsx` | 308 resource rows | Original Spring import, followed by Download-type and public-access task commits. No durable row report survives. |
| 2026-09-15 | `Resources_-_categorising-tagging_YOUTUBE_FINALISED_1789471419015.xlsx` | 195 nonempty sheet rows after header; task records 193 valid-link rows | Classification-only revision of existing videos. Validation and apply commits survive. The task states generated reports are absent, so current files do not provide a durable row journal. |
| 2026-09-15 | `Resources_-_categorising-tagging_PRESENTATIONS_FINALISED_1789478058638.xlsx` | 1,445 | New presentation import. Durable proposal, snapshot, journal, before/after and verification survive. Historical result: 1,354 inserts, 4 updates, 87 blocked, zero-write replay. |
| 2026-09-15 | `Resources_-_categorising-tagging_POSTERS_FINALISED_1789479638626.xlsx` | 921 | Metadata/access/classification revision of the June posters. All 921 URLs matched historical destination records; 920 updated and row 567 was excluded. Per-row intent/result journal survives. |
| 2026-09-15 | `Resources_-_categorising-tagging_FINALISED_1789486104337.xlsx` | 530 | Mixed “final resources” revision. Proposal initially had 276 blocked; approved taxonomy additions changed executable scope. Historical result: 379 inserts, 27 updates, 3 unchanged, 121 blocked, zero-write replay. |
| 2026-09-15 | `Resources_-_categorising-tagging_2026_PRESENTATIONS_AND_POSTE_1789489599381.xlsx` | 308 | Later Spring 2026 presentations/posters revision. Historical result: 12 inserts, 161 updates, 135 blocked, zero-write replay. This overlaps the July Spring workbook and must not be added as a disjoint set. |

Exact checksums, byte sizes, sheet ranges and commit IDs are in
`scope-evidence.json`.

## Revision and overlap rules

1. `bnms-resources2` and `bnms-resources3` have the same SHA-256 and are one
   logical poster source.
2. The September poster workbook is a revision of existing June poster rows:
   its historical report matched all 921 literal URLs.
3. The July Spring workbook and September Spring workbook each contain 308
   resource rows. They are revisions/overlap candidates, not 616 independent
   expectations.
4. The YouTube finalised workbook is classification-only. It must not be counted
   as a new-resource upload.
5. `Lists` and `Categories Event Photos & News` sheets are reference taxonomy,
   never resource rows.
6. Repeated source rows are retained in row-level audit output, but deduplicated
   totals must use exact URL or conservative provider identity. Titles are only
   review candidates.

## Report schema and row-history linkage

The September proposal families use a compatible row schema:

- `row`: one-based Excel row on the `Resources` sheet;
- `source`: literal source cells;
- `hyperlinks`/`formulas`: embedded workbook link evidence where present;
- `url` and `link.identity`: literal URL and conservative Drive/provider key;
- `candidateIds`, `matchMethod`, `before.id`: destination matching evidence;
- `proposed`, `patch`, `issues`, `status`: intended action and blockers.

This supports the following history chain:

`input SHA-256 → Resources!row → literal URL/provider identity → candidateIds or
before.id → journal row/id → after snapshot → verification/replay`.

The presentations, final-resources and Spring journals store row-bearing arrays
inside a transaction intent. The posters journal is more granular: 1,844 lines
represent per-row intent/result evidence for 920 updates plus terminal evidence.
The report workbooks are review views; JSON and JSONL are the authoritative
machine-readable linkage.

Saved execution journals:

- `reports/bnms-presentations/execution/2026-09-15T13-38-24.208Z/journal.jsonl`
- `reports/bnms-posters/execution/2026-09-15T15-25-46.706Z/journal.jsonl`
- `reports/bnms-final-resources/execution/2026-09-15T16-03-05.701Z/journal.jsonl`
- `reports/bnms-spring-2026-resources/execution/2026-09-15T16-46-42.963Z/journal.jsonl`
- `reports/bnms-spring-2026-resources/execution/2026-09-15T16-48-12.647Z/journal.jsonl`

## Historical report results are not current findings

Historical verification records complete, count-checked reads beyond 1,000
resources and zero-write replays for the four report families. They establish
what those executions reported at the time; they do **not** establish current
presence:

- Presentations: 1,358 writes; 87 blocked.
- Posters revision: 920 writes; row 567 excluded.
- Final resources: 407 writes including four taxonomy additions; 121 blocked.
- Spring revision: 173 writes; 135 blocked.

Blocked rows can represent invalid links, title-only candidates, ambiguous
identity, missing taxonomy or deliberately held access/core changes. They are
historical exceptions, not automatically “missing resources”.

## Caveats for the full audit

- Workspace survival is not exhaustive upload history.
- May/June/July import-named commits are weaker evidence than September’s
  journals; no row-level execution artifacts survive for those early runs.
- YouTube has apply code and commits but no surviving generated report/journal.
- The initial CSV task’s stated row count conflicts with the surviving parsed
  file and must be reported, not silently normalised.
- Current destination status requires the separately authorised read-only,
  ordered, paginated production snapshot. This scope pass did not perform it.
- URL availability alone cannot prove whether a resource import succeeded.
- Filesystem mtimes are corroborating only; git dates, checksums, tasks and
  report timestamps are the provenance anchors.
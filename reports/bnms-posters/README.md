# BNMS posters: approval required

Final approval package: `2026-09-15T13-50-57.289Z/`.

| Proposed action | Workbook rows |
| --- | ---: |
| Insert | 0 |
| Update | 920 |
| Unchanged | 0 |
| Blocked | 1 |

All 921 literal resource URLs uniquely match existing BNMS records. The
comparison covered all 2,859 destination resources and six taxonomy definitions,
using two identical, ordered, count-checked reads. No database writes occurred.

## Approvals needed

1. Make the 920 non-blocked resources member-only and add the workbook
   classifications. The blocked record also currently has public access, but
   must be resolved separately. Preserve existing tags and classifications.
2. Approve 191 exact title replacements. These include removal of existing
   season/year prefixes and restoration of workbook formatting. The workbook
   lists every before/proposed value; do not approve title changes implicitly.
3. Confirm the January 1 year-only date convention. Existing dates already
   agree, so no date changes are proposed. No description changes are proposed.
4. Preserve existing External Link display types. Download is an optional,
   separate display-type decision, not part of the 920 updates. Posters remains
   the taxonomy classification.
5. Confirm Page URL and Menu Item remain audit-only context. Folder links must
   not become resource links. No menus, folders, tags or taxonomy definitions
   will be created.
6. Resolve source row **567**: both workbook and destination URL begin with a
   stray backtick before `https://`. Confirm the intended URL before approving
   any correction; no corrected URL has been substituted or fetched.

There are no ambiguous database matches, hyperlink identity conflicts or
unknown selected taxonomy values. Fifteen rows have same-title coincidences
with other records; those records were not used for matching. Management and
Management & Workforce are distinct verified Focus Area values. Working in NM
topic markers map to Focus Area, not Collection or Subject.

## Files

- `approval.xlsx`: row-level review with source content, hyperlinks, changes,
  before/proposed values, match candidates, decisions and taxonomy.
- `approval-summary.md`: detailed approval summary, checksums and read coverage.
- `audit.json`: complete machine-readable row proposal.
- `snapshot.json`: destination comparison fields and taxonomy for offline replay.

The before/proposed objects contain the selected comparison fields, not a
full-row replacement payload. Any future executor must use explicitly approved
field patches and recheck current destination state; fields not selected for
this comparison must remain untouched. No apply mode exists in this work.

Validation: 14 focused tests passed. The generator also verifies offline
reproducibility and checks that every changed proposed field is disclosed.
The approval package was regenerated after that check was added.
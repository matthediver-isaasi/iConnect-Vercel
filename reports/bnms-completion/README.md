# Returned BNMS completion workbook — read-only comparison

Scope is exclusively `bnms-missing-resources-completion_(2)_1793688904161.xlsx`,
worksheet **Missing resources**, 257 rows. SHA-256:
`85d3de9760320071186f7d9dacbb4b069a1f95389c98a99210b9939e0dae5dfb`.

Run `node scripts/prepare-bnms-completion.mjs --dry-run`.
There is no apply mode. The REST transport permits only GET requests to the
pinned DEST tenant/resource/category endpoints, with explicit BNMS filters.
Two complete ordered count-checked snapshots must agree before reports are made.
The historical audit is evidence only, not an execution instruction.

Outputs are timestamped under `generated-artifacts/bnms-completion/` (excluded
from Git/deployment): review workbook, complete audit JSON, safe-subset JSON,
snapshot, issue index and summary. The subset has its own checksum and remains
unapproved regardless of its analytical status.

Dates supplied as numeric text are held rather than assumed to be Excel serial
dates. Month/year-only values require a complete date or separately agreed
convention. Missing dates never erase stored dates. Existing resource access,
roles and unrelated metadata remain untouched in proposals. New resources'
proposed public/member-only access is shown explicitly.

All 36 actual focus-area columns are compared. Only existing historical aliases
are used (Artificial Intelligence and Management and Workforce); exact parent
availability and resource applicability are checked. Unresolved URLs are grouped
by literal text where possible but are not asserted to be unique resources.
Reference and Source reference, original cells, hyperlinks/formulas, historical
holds, proposed changes and corrections are retained.

Tests:
`node --test scripts/bnms-completion-proposal.test.mjs scripts/bnms-final-resources-proposal.test.mjs scripts/audit-bnms-resource-imports.test.mjs`

Any subsequent live application requires separate authorization of the exact
subset and historical conflict resolutions, fresh drift checks and zero-write
replay verification. Do not run the historical hard-coded apply scripts for this
workbook.

## Fresh comparison, 2026-11-03 07:04 UTC

3,408 current resources and six taxonomy parents were read twice identically.
The 257 rows classify as one proposed insert, one proposed update, one unchanged
and 254 blocked. There are 242 valid resource identities (239 blocked, one each
insert/update/unchanged), plus 15 invalid-URL rows in ten unresolved literal
groups. These unresolved groups are not confirmed unique resources.

The approval-only subset is:
- `BNMS-866AD4D68732`, worksheet row 35: insert EANM Paetiatric Task Group
  Guidelines with the supplied URL, description and public access.
- `BNMS-345D1208412C`, worksheet row 129: rename Going for a Nuclear Medicine
  Test to General Nuclear Medicine Scan Information and add Patient and Carers
  to existing classifications, retaining access and all unrelated metadata.

Both require confirmation that returned consolidated values supersede the
historical duplicate holds. All 257 readiness cells are blank.
Subset SHA-256:
`460929949c93d7e05d4148084c97953e5938c529e2d98b393aef36a96dce23d5`.

Overlapping blockers: 149 missing Collection:Events; 159 ambiguous/incomplete
dates; 134 title-only candidates; 93 missing access and Collection values;
91 missing Resource Type values; 15 invalid URLs; ten conflicting duplicate
rows; two missing titles; one unresolved historical hyperlink conflict.
Non Medical Reporting is now available for one historically taxonomy-held row,
but that row still has other blockers.

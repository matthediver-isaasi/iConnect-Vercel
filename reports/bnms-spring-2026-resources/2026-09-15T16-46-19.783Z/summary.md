# BNMS Spring Meeting 2026 — read-only reconciliation report

**READ ONLY. No database or taxonomy writes occurred.**

Tenant: BNMS (ff2df806-b321-4254-b651-3af11fccf1db)  
DEST project: lvmzliemqnieeoruhkik  
DEST URL: https://lvmzliemqnieeoruhkik.supabase.co  
Read window: 2026-09-15T16:46:07.067Z to 2026-09-15T16:46:19.783Z

## Source and coverage

- Source: attached_assets/Resources_-_categorising-tagging_2026_PRESENTATIONS_AND_POSTE_1789489599381.xlsx
- Workbook SHA-256: db61ce39f47baec8a8bb48bc2c8a0a40081163193e139b816e0e6300d3b5c1e0
- Resources rows: 308 (expected 308)
- Workbook headers: 41; Lists is reference-only and not imported
- Destination snapshot SHA-256: 0d30b9447c3eec1463bc4b1581973ca9734a98406a299971225adb521ceb06bb
- Destination resources: 3257; ordered pages: 500, 500, 500, 500, 500, 500, 257
- Destination taxonomy definitions: 6; ordered pages: 6
- Two complete exact-count-checked ordered reads were identical.
- REST transport rejects non-GET methods; database writes: 0.
- Resource display type for these Drive files: download (verified against DEST).

## Row-level totals

- sourceRows: 308
- distinctLiteralUrls: 308
- destinationResources: 3257
- inserts: 12
- updates: 161
- unchanged: 0
- blocked: 135
- exactMatchRows: 56
- providerIdentityMatchRows: 115
- identityMatchRows: 115
- unmatchedRows: 137
- multipleDestinationRows: 2
- titleOnlyRows: 125
- coreChangeRows: 9
- coreChangeFields: {"target_url":0,"title":0,"description":9,"release_date":0}
- accessChangeRows: 169
- nonBlockedAccessChangeRows: 161
- classificationChangeRows: 169
- displayTypeChangeRows: 0
- yearOnlyRows: 0
- invalidDateRows: 0
- missingTaxonomyRows: 8
- duplicateSourceGroups: 0
- duplicateSourceRows: 0
- hyperlinkRows: 0
- hyperlinkConflicts: 0
- formulaRows: 0
- databaseWrites: 0

## Mapping and safeguards

- Resource URL maps to target_url for inserts. Exact URL is preferred; unique Google Drive file identity is the conservative fallback. Identity-matched existing rows retain their stored URL variant.
- Title and Brief Description map to title and description. Blank descriptions preserve existing descriptions.
- Blank source dates preserve existing release dates and become null only for inserts. No date is inferred.
- Member Only Yes is explicitly applied as is_public=false, including existing public matches. Existing allowed_role_ids and member_group_id are preserved.
- These Drive resources use resource_type=download. Existing and new rows are checked against the current DEST value before execution.
- Events maps to the Collection category; Presentation or Posters maps to Resource Type; Yes-marked topics map to Focus Area. Artificial Intelligence maps to Artificial intelligence and Management and Workforce maps to Management & Workforce.
- Existing classifications and tags are additive/preserved. Unknown taxonomy values, including any value absent from the verified Focus Area category, are blocked; no taxonomy additions are proposed.
- Page URL and Menu Item remain audit context only. They never become resource URLs, folders, tags, menus, or inferred classifications.
- Embedded hyperlinks and formulas are retained in the row audit. Conflicting identities and formula-bearing rows are blocked.
- Multiple destination candidates, repeated source identities, and title-only coincidences are blocked. Titles never select a destination row.

## Existing field changes requiring review

- subcategories: 169 rows (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 43, 44, 46, 47, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174)
- is_public: 169 rows (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 43, 44, 46, 47, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174)
- description: 9 rows (32, 52, 61, 86, 116, 117, 118, 121, 159)

## Held-row issues

- missing_taxonomy:Focus Area:Highlights: 2, 3, 4, 5, 68, 69, 126, 144
- title_only_candidate_requires_review: 41, 45, 175, 176, 177, 178, 179, 180, 182, 183, 184, 185, 186, 187, 189, 190, 191, 192, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 214, 215, 216, 218, 219, 220, 221, 222, 223, 225, 226, 227, 228, 229, 230, 231, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 251, 252, 253, 254, 255, 256, 257, 258, 260, 261, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 284, 285, 286, 288, 289, 290, 291, 292, 293, 294, 295, 296, 297, 298, 299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309
- multiple_destination_matches: 42, 48
- invalid_url: 45

## Duplicate source identities

- None.

## Reproducibility

- audit.json contains every source row, hyperlink/formula metadata, matching candidates, before/proposed values, patches, and issues.
- snapshot.json contains the complete ordered tenant-scoped resources and taxonomy used by this comparison.
- approval-report.xlsx is the compact review copy.
- Generator SHA-256 values are recorded in audit.json and the workbook provenance sheet.
- Re-run read-only: node scripts/prepare-bnms-spring-2026-resources.mjs --dry-run
- Tests: node --test scripts/bnms-spring-2026-resources.test.mjs
- Execution refreshes all reads, rechecks source and destination identity, and writes only after atomic SQL drift checks.

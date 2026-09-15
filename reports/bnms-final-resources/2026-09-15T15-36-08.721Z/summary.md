# BNMS final Resources — read-only approval comparison

**READ ONLY. No database or taxonomy writes occurred. This package is not an
execution instruction and has no live/apply mode.**

Tenant: BNMS (ff2df806-b321-4254-b651-3af11fccf1db)  
DEST project: lvmzliemqnieeoruhkik  
DEST URL: https://lvmzliemqnieeoruhkik.supabase.co  
Read window: 2026-09-15T15:35:56.581Z to 2026-09-15T15:36:08.721Z

## Source and coverage

- Source: attached_assets/Resources_-_categorising-tagging_FINALISED_1789486104337.xlsx
- Workbook SHA-256: 0c408805b7dabb1ae84fb152de29043de8d3ebb045626f74fffb32d3b95e838e
- Resources rows: 530 (expected 530)
- Workbook headers: 38; all 29 topic columns mapped to Focus Area
- Reference sheets **Lists** and **Categories Event Photos & News** were inspected as reference only; no photos/news taxonomy or records are proposed.
- Destination snapshot SHA-256: 8e5e8c689c7e0d3fb40c8e40b5732bbbc7db6614c40b796f1a8033e7208950a1
- Destination resources: 2878; pages: 500, 500, 500, 500, 500, 378
- Destination taxonomy definitions: 6; pages: 6
- Two ordered, exact-count-checked tenant reads were made for resources and taxonomy; the second read hash was identical.
- REST client refuses non-GET methods; database writes: 0.
- Generator SHA-256 values are recorded in audit.json and the workbook provenance sheet.

## Totals (source-row level)

- sourceRows: 530
- distinctLiteralUrls: 525
- destinationResources: 2878
- inserts: 225
- updates: 26
- unchanged: 3
- blocked: 276
- exactMatchRows: 28
- providerIdentityMatchRows: 17
- unmatchedRows: 485
- exactMatches: 28
- identityMatchRows: 17
- multipleDestinationRows: 1
- titleOnlyRows: 1
- coreChangeRows: 29
- nonBlockedCoreChangeRows: 14
- coreChangeFields: {"target_url":0,"title":15,"description":29,"release_date":0}
- accessChangeRows: 14
- accessChanges: 14
- nonBlockedAccessChangeRows: 0
- classificationChangeRows: 30
- yearOnlyRows: 23
- invalidDateRows: 0
- missingTaxonomyRows: 172
- duplicateSourceGroups: 5
- duplicateSourceRows: 10
- hyperlinkRows: 155
- hyperlinkConflicts: 1
- formulaRows: 0
- databaseWrites: 0

Blocked rows are excluded from executable insert/update/unchanged totals. Every
non-blocked update still requires explicit approval.

## Mapping and safeguards

- Resource URL → target_url for inserts. An identity-matched existing record retains its stored URL variant; URL variants are never silently rewritten.
- Title → title; Brief Description → description. A blank source description preserves an existing description rather than erasing it.
- Date → release_date. Excel serial dates are parsed using the existing BNMS helper. Four-digit year-only cells use January 1 as an approval convention and are flagged, not treated as a known day. Year-only source rows: 12, 27, 40, 43, 44, 45, 46, 50, 53, 54, 62, 206, 211, 447, 470, 471, 472, 473, 475, 476, 479, 480, 482.
- Member Only Yes → is_public=false; No → is_public=true for inserts. Existing is_public=false records remain restricted even when a source row says No; no access widening is proposed for those records.
- Collection → Collection subcategory; Resource Type → Resource Type subcategory; Yes topic markers → Focus Area subcategories. Management and Workforce maps only to the verified Management & Workforce value; Management and Radiopharmacy are mapped from this workbook's own topic headers.
- Existing subcategories are additive. Existing tags, allowed_role_ids, status, display type, folder/event links, author fields, and every other non-mapped field are preserved. No tags are inferred.
- Unknown or missing taxonomy is held and reported; no category or subcategory is created.
- Matching is conservative: exact trimmed URL first, then Drive-file or YouTube identity. Multiple destination candidates block the row. Repeated source identities block every row in the group. Titles are evidence only; title-only candidates block and never select an update.
- Page URL and Menu Item remain audit context. They do not become resource URLs, menus, folders, tags, or inferred classifications.
- Hyperlinks are captured and checked for blank targets/literals and identity conflicts. Formula-bearing rows are held for review; the reviewed workbook has no formulas.

## Exact changes requiring approval

### Existing mapped field changes

- description: 29 rows (6, 9, 10, 11, 12, 14, 16, 18, 19, 20, 21, 22, 30, 31, 395, 397, 399, 403, 405, 407, 409, 411, 413, 415, 417, 425, 427, 429, 472)
- subcategories: 30 rows (7, 8, 10, 13, 15, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 403, 405, 407, 409, 411, 413, 415, 417, 425, 427, 429, 472)
- title: 15 rows (395, 397, 399, 403, 405, 407, 409, 411, 413, 415, 417, 425, 427, 429, 472)
- is_public: 14 rows (395, 397, 399, 403, 405, 407, 409, 411, 413, 415, 417, 425, 427, 429)

Core fields are target_url, title, description and release_date. Classification
additions and access changes are counted separately above and shown row by row
in **Core changes** and **Rows**. The exact core-field counts are included in
coreChangeFields; the full before/proposed values remain in audit.json.

### Missing taxonomy

missing_taxonomy:Resource Type:NM Images; missing_taxonomy:Resource Type:Patient Information leaflet; missing_taxonomy:Resource Type:Educational Resources; missing_taxonomy:Resource Type:Historical Resources

### Held-row issues

- conflicting_source_duplicate: 41, 64, 188, 195, 451, 454
- identical_source_duplicate_review: 100, 131, 168, 170
- hyperlink_conflict:C201: 201
- missing_taxonomy:Resource Type:NM Images: 219, 220, 221, 232, 259, 284, 290, 297, 299, 301, 303, 304, 310, 318
- missing_or_invalid_access: 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283, 285, 286, 287, 288, 289, 291, 292, 293, 294, 295, 296, 298, 300, 302, 305, 306, 307, 308, 309, 311, 312, 313, 314, 315, 316, 317, 319, 320, 321, 322, 323
- missing_classification:Collection: 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283, 285, 286, 287, 288, 289, 291, 292, 293, 294, 295, 296, 298, 300, 302, 305, 306, 307, 308, 309, 311, 312, 313, 314, 315, 316, 317, 319, 320, 321, 322, 323
- missing_classification:Resource Type: 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283, 285, 286, 287, 288, 289, 291, 292, 293, 294, 295, 296, 298, 300, 302, 305, 306, 307, 308, 309, 311, 312, 313, 314, 315, 316, 317, 319, 320, 321, 322, 323
- missing_taxonomy:Resource Type:Patient Information leaflet: 324, 337, 338, 339, 340, 341, 342, 343, 344, 345, 346, 347, 348, 349
- title_only_candidate_requires_review: 337
- missing_taxonomy:Resource Type:Educational Resources: 350, 351, 352, 353, 354, 355, 356, 357, 358, 359, 360, 361, 362, 363, 364, 365, 366, 367, 368, 369, 370, 371, 372, 373, 374, 375, 376, 377, 378, 379, 380, 381, 382, 383, 384, 385, 386, 387, 388, 389, 390, 391, 392, 393, 394, 395, 396, 397, 398, 399, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 424, 425, 426, 427, 428, 429, 449, 450, 451, 452, 453, 454, 455, 456, 457, 458, 459, 460, 461, 462, 463, 464, 465, 466, 467, 468, 481, 482, 483, 484, 485, 486, 487, 488, 489, 490, 491, 492, 493, 494, 495, 496, 497, 498, 499, 500, 501, 502, 503, 504, 505, 522, 523, 524, 525, 526, 527, 531
- missing_taxonomy:Resource Type:Historical Resources: 469, 470, 471, 472, 473, 474, 475, 476, 477, 478, 479, 480
- multiple_destination_matches: 519
- invalid_url: 520, 528, 529

### Duplicate source identities

- Rows 41, 64 (other, conflicting): https://onlinelibrary.wiley.com/doi/pdf/10.1111/cen.12515; differing fields: Title, Brief Description
- Rows 100, 168 (other, identical): https://www.nice.org.uk/guidance/ng28; differing fields: none
- Rows 131, 170 (other, identical): https://www.nice.org.uk/guidance/ng185; differing fields: none
- Rows 188, 195 (other, conflicting): https://eanm.org/publications/guidelines/; differing fields: Title, Brief Description
- Rows 451, 454 (drive_file, conflicting): drive:1lQOZhfi5yqVBz0vI0rDtsSVicKS9g6C1; differing fields: Title

## Files and reproducibility

- **approval-report.xlsx** — compact user review workbook with totals, every source-row decision, blocked rows, core changes, taxonomy/role snapshot and provenance.
- **audit.json** — complete machine-readable source rows, hyperlinks/formulas, matching candidates, before/proposed values and issues.
- **snapshot.json** — tenant, full ordered resource rows and full taxonomy rows used by this comparison (including role restrictions).
- **summary.md** — this decision summary.

Re-run read-only:
`node scripts/prepare-bnms-final-resources.mjs --dry-run`

Focused tests:
`node --test scripts/bnms-final-resources-proposal.test.mjs`

Before any separately approved execution, refresh the workbook checksum,
destination identity, taxonomy and all before-values; stop on any drift.

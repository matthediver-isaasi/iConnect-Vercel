# BNMS posters — approval proposal

**READ ONLY. Execution remains pending explicit approval. No database or taxonomy writes.**

Tenant: BNMS (British Nuclear Medicine Society), ff2df806-b321-4254-b651-3af11fccf1db. DEST project: lvmzliemqnieeoruhkik.
Read window: 2026-09-15T15:20:37.013Z to 2026-09-15T15:20:48.757Z.

## Counts
- sourceRows: 921
- distinctLiteralUrls: 921
- distinctTitles: 913
- existingResources: 2878
- exactMatches: 921
- driveIdentityMatches: 0
- ambiguousMatches: 0
- unmatchedRows: 0
- insert: 0
- update: 920
- unchanged: 0
- blocked: 1
- accessChanges: 921
- nonBlockedAccessChanges: 920
- titleChanges: 191
- taxonomyIssues: 0
- titleOnlyCoincidenceRows: 15
- preservedNonDownloadTypes: 921
- hyperlinkConflicts: 0
- databaseWrites: 0

Counts are row-level against current DEST, not estimates. Blocked rows are excluded from insert/update/unchanged totals. Even non-blocked updates require approval.

## Decisions for approval
- All proposals use is_public=false. Existing allowed_role_ids, tags, status and other non-mapped settings remain unchanged. Public-to-member-only changes require approval; none has been applied.
- Resource URL, Title and Brief Description are retained literally, including whitespace and empty descriptions. Review metadata differences in the workbook before approving replacements.
- Dates are calendar years 2016–2025, not Excel serial dates. Approve the established January 1 year-only convention; this does not assert a known event date.
- New resources would use display type Download (download), status active and the original Drive URL. Posters is a separate Resource Type taxonomy classification. Existing display types are preserved; conversion to Download is NOT included.
- Classifications are additive: Events under Collection; Posters under Resource Type; trimmed case-insensitive X topic markers under Focus Area. Management remains Management; Management and Workforce maps to the verified Management & Workforce. Working in NM markers map to Focus Area, NOT Collection or Subject. Existing tags/classifications are never removed.
- Page URL contains folder links and is retained separately in the audit, never used as the resource target or identity. Menu Item is source grouping context only. Approve retaining both as audit-only, with no automatic tags, folders, menus or classifications created.
- Lists and Categories Event Photos & News are reference sheets only; no records are proposed from them.
- Exact Resource URL matches are preferred; conservative Drive file identity is fallback. Any additional identity candidate blocks the row even if one exact URL exists. Titles never select a record to update. Resolve blocked links or duplicate candidates explicitly; no duplicate deletion is proposed.
- Taxonomy names exist in multiple category groups; the app stores flat subcategory names. Proposed names are verified against the intended group, but existing category access rules are not changed. Snapshot includes those restrictions for review.

## Changed fields on uniquely matched rows
- title: 191 rows
- is_public: 921 rows
- subcategories: 921 rows

## Blocked issues and source rows
- invalid_resource_file_url: 567

## Provenance and coverage
- Source: attached_assets/Resources_-_categorising-tagging_POSTERS_FINALISED_1789479638626.xlsx
- Workbook SHA-256: 853c7e8b5202fe3ce0f8175aa97bf89f0d054e5fa7502dfcf18852767a0dc972
- Destination snapshot SHA-256: 96298a1b3b5fca05cf4b3fc56dfd428dace0472f4df8825560ef76da55ae2495
- Resource pages: 500, 500, 500, 500, 500, 378; exact total 2878.
- Category pages: 6; exact total 6.
- Two ordered, count-checked full reads were identical. This is not a transactional backup; any approved execution must refresh and compare the before-values again.

approval.xlsx contains source rows, before/proposed values, differences, decisions and taxonomy. audit.json is the complete machine-readable row audit; snapshot.json is the replay input. Reproduce with node scripts/prepare-bnms-posters-import.mjs. Test with node --test scripts/bnms-posters-proposal.test.mjs.

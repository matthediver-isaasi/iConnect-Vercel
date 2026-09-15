# BNMS presentations — approval proposal

**No live changes have been applied. All totals below are proposed, not executed.**

Read at: 2026-09-15T13:27:11.746Z
Tenant: BNMS (ff2df806-b321-4254-b651-3af11fccf1db)
Workbook SHA-256: 0e522c5e96581bce9b23dc35841638724266a98c5060d79c19ac66153dbbb998
Destination snapshot SHA-256: 7aa2c4a3c4abb2812f1c476fb2ed82ab6f0c4b9655132c943e20d804f0fdc838
(Hash of the exact saved destination-snapshot.json bytes. Generator file hashes are recorded in proposal.json.)

## Proposed operations
- sourceRows: 1445
- distinctLiteralUrls: 1441
- destinationResources: 1505
- inserts: 1354
- updates: 4
- unchanged: 0
- blocked: 87
- exactMatchRows: 0
- identityMatchRows: 4
- unmatchedRows: 1441
- coreChangeRows: 4
- accessChangeRows: 0
- yearOnlyRows: 1445
- databaseWrites: 0

Skip for this proposal: 87 rows (0 unchanged; 87 blocked pending decisions).
All 1445 populated Resources rows were compared with all 1505 destination resources. Ordered, exact-count-checked pages: 500, 500, 500, 5. Taxonomy pages: 6. Other worksheets are references only.

## Mapping for approval
- Resource URL → target_url for inserts; matched resources retain their existing URL variant.
- Title → title; Brief Description → description (blank source preserves existing description).
- Date → release_date. Four-digit years propose **1 January of that year**, not an Excel serial. This convention requires approval; source raw values remain in the audit. Blank source preserves an existing date.
- Member Only Yes → is_public=false. No would allow public only for new/already-public records; existing restrictions, allowed roles, tags, status, folders, member-group links and other fields are preserved.
- New links use external_link, open_in_new_tab=true, active status, no role-specific restrictions beyond member-only access.
- Collection → existing Collection; Resource Type → existing Resource Type; Yes-marked topic columns → existing Focus Area, with Management and Workforce → Management & Workforce and Artificial Intelligence → Artificial intelligence.
- Classifications are additive: no existing classifications or tags removed. Missing taxonomy is blocked, not created.
- Menu Item and Page URL are audit-only; no menus/pages or inferred meeting collections are created. Working in NM is a Focus Area marker (blank in this source). Highlights is treated as a candidate Focus Area only if that exact destination value exists; otherwise selected rows are unresolved, requiring an explicit mapping decision rather than navigation changes.
- Unique exact URL preferred, then conservative Drive file/YouTube identity. Multiple destination candidates, repeated source links, shared folders and title-only candidates require review; no title-only mutations.

## Decisions required
1. Approve the field mapping and year-only date convention.
2. Approve each proposed existing core/access change separately (see Core changes sheet and full before/proposed values).
3. Resolve missing taxonomy: missing_taxonomy:Focus Area:Non Medical Reporting; missing_taxonomy:Focus Area:Highlights; missing_taxonomy:Focus Area:Metabolic Studies; missing_taxonomy:Focus Area:Sentinel Node Imaging.
4. Resolve blocked rows listed in the workbook; blanks never imply public access.
5. Supply distinct file links or explicit per-row handling for repeated/shared links; nothing is silently collapsed.

### Existing core changes requiring separate approval
- Row 813: title, description, release_date. Date: 2022-02-01T00:00:00+00:00 → 2021-01-01. Title: "From design to radiolabelling - understanding the radiochemistry" → "S2021 - From design to radiolabelling - understanding the radiochemistry".
- Row 814: title, description, release_date. Date: 2022-02-04T00:00:00+00:00 → 2021-01-01. Title: "From lab to radiopharmacy - translating to the clinic" → "S2021 - From lab to radiopharmacy - translating to the clinic".
- Row 815: title, description, release_date. Date: 2022-02-01T00:00:00+00:00 → 2021-01-01. Title: "From radiochemistry to first images - in vitro and in vivo testing" → "S2021 - From radiochemistry to first images - in vitro and in vivo testing".
- Row 821: title, description, release_date. Date: 2022-02-04T00:00:00+00:00 → 2021-01-01. Title: "Overcoming the challenges of reaching the bedside" → "S2021 - Overcoming the challenges of reaching the bedside".
No existing access changes are proposed in this comparison.

### Held-row reasons (overlap is possible)
- missing_taxonomy:Focus Area:Non Medical Reporting: 6 rows
- conflicting_source_duplicate: 45 rows
- missing_taxonomy:Focus Area:Highlights: 16 rows
- missing_taxonomy:Focus Area:Metabolic Studies: 17 rows
- missing_taxonomy:Focus Area:Sentinel Node Imaging: 2 rows
- missing_or_invalid_access: 1 rows
- missing_classification:Collection: 1 rows
- missing_classification:Resource Type: 1 rows
- shared_folder_requires_individual_link_review: 3 rows
The row missing access, Collection and Resource Type is 540.

## Repeated link investigation
- Rows 74, 84: youtube; different source metadata; all blocked. Differing fields: Title, Brief Description. Identity: youtube:xPh2s6vZaSo. Titles: 74: A2021 - 1. Emerging role of [18F]florbetaben-PET/CT in assess ment and management of people living with HIV and subjective cognitive impairment. / 84: A2021 - 2.  Interobserver Variability in the Qualitative and Quantitative Analysis of Cardiac MIBG Scintigraphy for the Diagnosis of Lewy Body Disorders
- Rows 218, 1427: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Brief Description, Educational, Management and Workforce. Identity: drive:1k_oNxwmwesDX5nqblI-nkDTxS5dCr1h4. Titles: 218: A2025 - The Benefits of Involving Patients in Their Care / 1427: A2025 - The Benefits of Involving Patients in Their Care
- Rows 219, 1428: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Title, Brief Description, Oncology, PET and PET-CT. Identity: drive:1wUbcpu-gFwZV6BaO2Luv__GEIFiTxPxk. Titles: 219: A2025 - PET-CT in the Era of Immunotherapy  / 1428: A2025 - PET-CT in the Era of Immunotherapy
- Rows 220, 1429: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Title, Brief Description, Neurology, PET and PET-CT. Identity: drive:1oCeyc3R7M-src40uZOLekF7Z5nNhz5WR. Titles: 220: A2025 - Total Body PET - What’s in it for Neuro?  / 1429: A2025 - Total Body PET - What’s in it for Neuro?
- Rows 221, 1430: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Title, Brief Description, Cardiovascular, PET and PET-CT. Identity: drive:1fQMhSUjzM8wEoDyKAbVRIEGkdyGMgecm. Titles: 221: A2025 - Diabetes and FDG Cardiac PET – Challenges  / 1430: A2025 - Diabetes and FDG Cardiac PET – Challenges
- Rows 222, 1431: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Title, Brief Description. Identity: drive:1wKW9nu7q2rkCmglZsYAOhjRLqco4U3-J. Titles: 222: A2025 - Transformation in Nuclear Medicine  / 1431: A2025 - Transformation in Nuclear Medicine
- Rows 223, 1432: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Brief Description, Educational, Management and Workforce. Identity: drive:19vxbWZiwDckIeDaMcDDGUHC5RvXRHhP8. Titles: 223: A2025 - Research in Nuclear Medicine / 1432: A2025 - Research in Nuclear Medicine
- Rows 224, 1433: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Brief Description, Educational, Management and Workforce. Identity: drive:1J0xblQYCReZwa4nOO4bZWPBdsmTuGtus. Titles: 224: A2025 - Nuclear Medicine Practice Educator Perspective / 1433: A2025 - Nuclear Medicine Practice Educator Perspective
- Rows 225, 1435: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Title, Brief Description. Identity: drive:14JA9fL_polMFOgBHApdPLWKYm5UPgmjd. Titles: 225: A2025 - Pathways to Advanced Practice / 1435: A2025 - Pathways to Advanced Practice - Tristan Barnden
- Rows 226, 1436: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Title, Brief Description. Identity: drive:18pQrTMc1uRfOV3DlM9wxHMsD_MdPTrHf. Titles: 226: A2025 - What’s New for PET in Cardiac Sarcoidosis  / 1436: A2025 - What’s New for PET in Cardiac Sarcoidosis
- Rows 227, 1437: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Brief Description. Identity: drive:1F2STFkyOkTOAd2saBRjvC3G0u_Tn1Irm. Titles: 227: A2025 - Radiopharmacy – Not Just for Pharmacists / 1437: A2025 - Radiopharmacy – Not Just for Pharmacists
- Rows 228, 1438: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Brief Description. Identity: drive:1eOfZFKwgcYaOjf11hXWsnlfRwaag0zTu. Titles: 228: A2025 - Radiopharmacy - Current Challenges and Good practices / 1438: A2025 - Radiopharmacy - Current Challenges and Good practices
- Rows 229, 1439: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Brief Description. Identity: drive:1qtuMmgxzh3Gdn76EkDPJgDz4k-WV71UI. Titles: 229: A2025 - Challenges of Radiopharmacy Supply / 1439: A2025 - Challenges of Radiopharmacy Supply
- Rows 230, 1440: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Brief Description. Identity: drive:1QmcKppkIvwzDG2ba3Z9ztPX-uT58vTwt. Titles: 230: A2025 - SIRT Cases / 1440: A2025 - SIRT Cases
- Rows 231, 1441: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Title, Brief Description. Identity: drive:1_rFuIp9L73iISVRn89oAjZRQ38U8QtB0. Titles: 231: A2025 - Rhenium-SCT: The Physicist's View  / 1441: A2025 - Rhenium-SCT: The Physicist's View
- Rows 232, 1442: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Brief Description. Identity: drive:1qRll194cJ_OSWxqc0-G96SfdFKCawmAq. Titles: 232: A2025 - EFRS & Sustainability in Nuclear Medicine / 1442: A2025 - EFRS & Sustainability in Nuclear Medicine
- Rows 233, 1443: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Brief Description, Management and Workforce, Neurology. Identity: drive:1ERa_HNxRu9DUis39N8utRBjg3F8moAbd. Titles: 233: A2025 - [131I]mIBG Therapy for Neuroblastoma - Attempts to Improve Results / 1443: A2025 - [131I]mIBG Therapy for Neuroblastoma - Attempts to Improve Results
- Rows 234, 1444: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Title, Brief Description. Identity: drive:1JAw53AA1HAwCjIw8vfkPxtSs4K4Qz96q. Titles: 234: A2025 - Carcinoid Crisis - Rare Side Effect of PRRT  / 1444: A2025 - Carcinoid Crisis - Rare Side Effect of PRRT
- Rows 235, 1445: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Title, Brief Description. Identity: drive:178v59GtQaMpn47x2J4bUPXrQqLlI5AKs. Titles: 235: A2025 - Peptide Receptor Radionuclide Therapy (PRRT) with Lutetium-177DOTATATE in Lung NET patients - Clinical outcomes  / 1445: A2025 - Peptide Receptor Radionuclide Therapy (PRRT) with Lutetium-177- DOTATAT
- Rows 236, 1446: drive_file; different source metadata; all blocked. Differing fields: Resource URL, Title, Brief Description, Management and Workforce, Molecular Radiotherapy. Identity: drive:1CItCxyL9fJepzrRq1rexGvLnEa4lVPtm. Titles: 236: A2025 - Multisuite Therapy Room  / 1446: A2025 - Multisuite Therapy Room
- Rows 582, 584: drive_file; different source metadata; all blocked. Differing fields: Title, Brief Description. Identity: drive:14h9Zsx-J81ggmQZDYQ7nQLLxq8lCSmhV. Titles: 582: S2018 - 69. Survival Benefit of Radium-223 Therapy for Bony Metastatic Castration-Resistant Prostate Cancer. / 584: S2018 - 70. (3rd Radiotherapy Prize Winner) Prognostic Value of PSA as a Marker for Survival in Bony Metastatic Castration-Resistant Prostate Cancer Patients Receiving Radium-223 Therapy
- Rows 1243, 1259, 1267: shared_folder; different source metadata; all blocked. Differing fields: Title, Brief Description, Cardiovascular, Educational. Identity: folder:1C4ewZagIL5WYSfqV8wVYT_6vmVEgQ5MS. Titles: 1243: S2024 - Nuclear Imaging in Amyloidosis / 1259: S2024 - Role of FDG PET in Infective endocarditis / 1267: S2024 - Targeted alpha therapy in oncology

## Reproducibility and execution boundary
proposal.json contains every raw source row, hyperlink metadata, matching candidate IDs, before/proposed values, patch and issues. destination-snapshot.json contains the complete tenant-scoped resource/taxonomy comparison. approval-report.xlsx is the review copy.
Re-run: node scripts/prepare-bnms-presentations.mjs --dry-run
Tests: node --test scripts/bnms-presentations-proposal.test.mjs
This read was paginated, not a transactionally frozen backup. Before any separately approved execution, recheck workbook checksum, destination identity and all before-values/taxonomy; stop on drift. This runner has no apply mode and rejects non-GET requests.

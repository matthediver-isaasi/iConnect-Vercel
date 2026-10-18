---
name: BNMS historical membership archive
description: User-defined isolation boundary for original membership history retained in Data Studio.
---

BNMS's original membership history is to be retained as a basic historical Custom Data object with a relationship to a known member. It must not interact with existing membership data or flows.

**Why:** The user explicitly requested an archive only, not a migration into the operational membership system.

**How to apply:** Keep archive records separate from live membership history, status, billing, renewals, eligibility and automation. Linking an archive record to an existing member does not authorize changing that member or treating an old membership label/date as current authority.

Remove only exact duplicate source rows; retain distinct membership entries, including future dates and blank end dates. Do not add source-filename or spreadsheet-row fields to the object.

**Why:** The user approved deduplication only for exact duplicates and explicitly said source filename and spreadsheet row number were unnecessary.

**How to apply:** Compare all original columns before deduplication, without trimming or merging membership labels. Preserve the remaining values as archive evidence, not current membership authority.

The archive's dates must display in UK `dd/mm/yyyy` format.

**Why:** The user supplied UK-formatted dates and explicitly rejected US front-end presentation.

**How to apply:** Format date-only values for display without timezone conversion or swapping their stored month/day. A presentation complaint is not authorization to rewrite the imported dates.

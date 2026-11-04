---
name: BNMS returned completion approval
description: Approval boundaries when a completion workbook revises prior resource-import holds.
---

A returned BNMS completion workbook is a new analysis scope, not blanket
authorization to retry historical writes or reuse earlier date conventions.
Blank readiness is not approval. Consolidated duplicate rows require explicit
confirmation of the returned values before applying the proposed subset.

**Why:** The owner requested a dry run first after categories were added, while
the returned workbook still left readiness and substantial metadata blank.
Earlier permissions applied to different source workbooks and do not settle
the new workbook's unresolved dates, identities or access.

**How to apply:** Pin the returned workbook and exact proposed subset, distinguish
current taxonomy resolution from other historical holds, and obtain separate
authorization before any live application.

Tenant-facing correction workbooks must use one worksheet with the individual
error/missing-data cells highlighted and a plain-English instruction column
for each row. Keep detailed audit evidence separate.

**Why:** The owner said the multi-sheet technical review was too complex to
pass to the tenant for corrections.

**How to apply:** Preserve source references for reconciliation, keep editable
values unchanged, and put technical evidence outside the tenant-facing sheet.
Both initially proposed resource changes were explicitly kept on hold by the
owner; returning a corrected sheet does not authorize their application.

# BNMS Supporter classification update

## Verified result

Applied atomically to production DEST project `lvmzliemqnieeoruhkik`, tenant
`ff2df806-b321-4254-b651-3af11fccf1db` (BNMS).

| Result | Members |
| --- | ---: |
| Exact source IDs matched | 48 |
| Updated primary role and Member class to Supporter | 47 |
| Already correct; untouched | 1 |
| Blocked or unmatched | 0 |
| Newly created members | 0 |

There were 47 primary-role updates, 47 existing class-value updates, and no
class-value inserts. Post-commit readback confirmed both requested values for
all 48 members. A separate read-only replay subsequently found **zero writes**.

## Scope and verification

- Workbook: `Individuals_update_role_and_class_import_12.11.26_1794470024358.xlsx`.
- SHA-256: `75e71d6eb6f7820081d52a80d0e355eed779b9a800fc58ed59b08531b9605b9a`.
- Exactly Sheet1, headers `member_id`, `role_name`, `Member class`, 48 unique
  nonempty UUIDs; all desired values Supporter. Formulas and malformed rows rejected.
- REST project and SQL destination were independently pinned; TLS certificate
  and hostname verification remained enabled.
- Existing nonprivileged Supporter role and active member-scoped class option
  resolved without creating definitions. No secondary role table exists in the
  inspected destination schema.
- Serializable transaction, locked cohort and definitions, complete pre-write
  snapshot digest, conditional writes, exact write counts, and readback checks.
- Full member-row comparison preserved every substantive unrelated field,
  including login settings, communication preferences and membership details.
  Other cohort preferences and automatic-group definitions/state were unchanged.
- In-transaction fingerprints confirmed all non-cohort member and preference
  rows, including other tenants, were unchanged by the transaction.
- No billing/provider operations, renewal operations, communications, or
  membership-history writes were performed.

The owner explicitly approved the existing triggers' metadata effects before
application: updated timestamps, two survey-invitation revision increments per
changed member, and member-content cache invalidation. Triggers were not disabled.
The unchanged member was verified unchanged in full.

## Recovery evidence and privacy

Private per-member before/after snapshots, plan, inspected trigger dependencies,
preservation fingerprints and committed result are retained with restricted file
permissions under `private/bnms-supporter-update/`, excluded from Git and deployment.
They are not embedded in this report or tests.

Applied plan SHA-256:
`b50d31bfed77bbd2ab8f0ead1f24be34faa900e1ede4a6141c6f51cad051745b`.

The source workbook is also excluded. Checks found neither the workbook nor private
evidence in the Git index, and no workbook entries in available Git history.
This does not establish purging or absence of external retained copies.

## Tests

`node --test scripts/update-bnms-supporter-classifications.test.mjs`

Seven passing tests cover strict workbook parsing, missing/duplicate/cross-tenant
and privileged records, invalid definitions, source/plan mismatches, simulated
concurrent drift, exact write-count guards, preservation, and zero-write replay.
The tests use synthetic fixtures, not real member IDs or private workbook contents.
Live verification used the destination database directly, not the workspace preview.

# BNMS presentations approval proposal

## Applied and verified

Following the user's approval, the import was saved to BNMS on DEST on 15 September 2026:

- **1,354 resources inserted**
- **4 existing resources updated**
- **87 unresolved rows skipped and left untouched**
- Resource count increased from **1,505 to 2,859**.
- Every approved resource remains member-only. All existing tags, classifications, role restrictions and unrelated fields were verified unchanged.
- No taxonomy changes were made.
- A second invocation of the SQL apply path made **zero writes**, followed by a complete count-checked REST comparison.

Execution files are in `execution/2026-09-15T13-38-24.208Z/`: `execution-report.xlsx`, `plan.json`, `before.json`, `transaction-result.json`, `after.json`, `verification.json` and `journal.jsonl`.

The saved original proposal below is immutable audit evidence, not an instruction to apply again. `scripts/apply-bnms-presentations.mjs --dry-run` can reconcile the exact approved before/after states; any unrelated destination drift intentionally stops the runner rather than overwriting it.

## Original approval snapshot

The completed read-only comparison is in `2026-09-15T13-27-11.746Z/`.

- `approval-report.xlsx`: all 1,445 source rows, approval guide, blocked rows, existing core changes, duplicate groups, taxonomy and provenance.
- `approval-summary.md`: approval totals and mapping decisions.
- `proposal.json`: full raw source, match candidates, before/proposed values and patches. Blocked patches are audit candidates only, not executable instructions.
- `destination-snapshot.json`: complete tenant-scoped resource and taxonomy snapshot used for comparison.

At this proposal stage, no live changes had been applied. Proposed totals were 1,354 inserts, 4 updates, 0 unchanged and 87 blocked. The later user approval authorized the 1,358 proposed writes, including the four title, description and date updates.

Reproduce using `readWorkbook` and `buildReport` from `scripts/bnms-presentations-proposal.mjs` with the original workbook and this snapshot. Run the tests with `node --test scripts/bnms-presentations-proposal.test.mjs`. A new read-only destination comparison is available with `node scripts/prepare-bnms-presentations.mjs --dry-run`.

The 87 blocked rows remain unresolved and are not authorized for automatic execution. Before any further import, resolve their source links, access and mapping questions explicitly, then prepare a fresh comparison.
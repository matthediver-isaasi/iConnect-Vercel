# GFI Q4 publications import

Completed 6 October 2026 against production DEST project
`lvmzliemqnieeoruhkik`, tenant `fd82da65-aab7-4a5c-85b8-b2febeb2003d`.

## Outcome

- Successful transaction: **75 inserted, 0 skipped, 0 errors**.
- 13 WCID; 62 Job profiles. 55 internal assignments; 20 external assignments.
- Four existing member identities resolved uniquely; three existing external
  writers reused by trimmed, case-insensitive email. No writer/member writes.
- Submission, writer and editor deadlines: **1 January 2027**, midnight UTC.
- Tenant stage: `in_progress`; SLA: `2026-2028`; contract: `Prospects`.
- Editors stored as review owners; internal and external assignments remain
  mutually exclusive. Source notes preserved; case study and copyright false.
- **20 NDA Yes flags reported only**, not stored in fields, notes or documents.
- All **224 pre-existing briefs** were compared in full and unchanged within the
  locked transaction. Final GFI brief total: **299**.
- Independent post-commit dry run: **0 planned inserts, 75 skipped, 0 errors**;
  all 75 existing records matched every approved field and linked identity.
- No other tenant writes, notifications, published content or schema changes.
- **No database migration needed or applied; none outstanding.**

The initial apply attempt rolled back entirely on a verification mismatch:
deadline columns are timestamps rather than dates. The verifier now compares
exact instants, and the transaction pins UTC. The successful counts above refer
to the subsequent committed transaction, not the rolled-back attempt.

## Reproduction and safeguards

Runner: `scripts/import-q4-publications-briefs.mjs`.
The exact workbook SHA-256 is
`4c78cf7c510ce6f1c8e12f3d6e5724c288a084107a08eb2ca7d421c8e3e66713`.
Only `Q4 data` is imported; all other sheets are ignored.

Read-only replay:

```sh
node scripts/import-q4-publications-briefs.mjs --dry-run
```

Apply requires `--apply --review-sha256=<plan hash from dry run>`. The approved
plan hash was
`977c151cb791b03039ae8f167e114f63ce466645dd5afa6b41e78249c9050fd6`.
The runner verifies DEST REST and SQL identity, certificate-verified TLS, tenant
name, stage settings, source totals, unique matches and title collisions. A
short table-level write lock serializes duplicate checks and insertion against
other brief writers. It never updates matching rows: mismatched collisions stop
the run. Unknown enabled triggers also stop the import before writes.

Five synthetic offline checks passed:

```sh
node --test scripts/import-q4-publications-briefs.test.mjs
```

Private per-row manifests are retained under the ignored
`private/gfi-q4-publications/` directory (directory mode 0700; files 0600).
The workbook was removed from the Git index but remains locally available and
ignored. This does **not** remove the upload from inherited Git/checkpoint history.
No source rows or personal information are included in this report or test data.

## Verification limits

Verification is against the actual production database, including post-commit
reconciliation, not an authenticated UI check. The local `/BriefManagement`
capture had no member session and used the workspace's legacy/default tenant
configuration; it could not display GFI production records. No authentication
bypass or session fabrication was used.

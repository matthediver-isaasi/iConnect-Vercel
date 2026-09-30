# BNMS posters — approved execution

The user explicitly approved `reports/bnms-posters/README.md` and
`2026-09-15T13-50-57.289Z/`: “Approve all listed changes; leave row 567 excluded”.

## Result

Executed on DEST only on 2026-09-15. Evidence:
`2026-09-15T15-25-46.706Z/`.

- 920 resources updated; no inserts or deletions.
- All 920 verified member-only, retaining existing role restrictions.
- 191 exact approved title replacements applied.
- Classifications added without removing existing values; tags preserved.
- Row 567 excluded and unchanged, including its malformed URL and existing access.
- Display types, descriptions, dates, URLs and every other resource field preserved.
- Taxonomy definitions and restrictions unchanged; no menus or folders created.
- SOURCE and presentations were not changed.
- Actual execution path replayed within a second transaction: **zero writes**.
- Full-row SQL verification before commit and independent REST verification after commit passed.

The fresh read-only package at `../2026-09-15T15-20-48.757Z/` covered 2,878
resources (19 more than the original proposal). The approved targets and patches
still matched; unrelated resources were preserved.

## Guarded executor

`node scripts/apply-bnms-posters.mjs --dry-run` checks the pinned package,
workbook, destination identity, live taxonomy, matches and before/after values.
`--apply` is the explicit write switch; it must not be used for any new scope.
Only the approved title, is_public and subcategories patches can be written.
The transaction rejects unreviewed custom resource triggers or rules, checks
full before-values under table locks, and rolls back on unexpected changes.

The evidence directory contains the approval and patch manifest, full before
and after resource snapshots, fsynced per-write journal, commit markers and
verification summary. A missing commit marker must be treated as uncertain,
not proof of rollback; inspect destination state before any recovery.

Validation: 18 focused tests passed using
`node --test scripts/bnms-posters-proposal.test.mjs scripts/apply-bnms-posters.test.mjs`.
This was a data-only change; no application code, workflow or deployment changes
were needed. Live database verification, rather than the legacy SOURCE-backed
workspace preview, establishes the result.
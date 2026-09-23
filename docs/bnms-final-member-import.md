# BNMS final member import

## Result

The pinned `Replacement Import` workbook was applied to destination project
`lvmzliemqnieeoruhkik`, BNMS tenant
`ff2df806-b321-4254-b651-3af11fccf1db`.

- 47 approved rows were inserted.
- 30 original conflict rows were held without changes.
- Worksheet rows 75 and 79 remained excluded.
- A post-commit replay found all 47 imported members already present and required
  zero writes.
- No migrations were needed or applied.

The user separately approved the existing supported regional automatic-group
rules, their queueing, and rechecking of existing assignments. This did not
authorize accounts, login, notifications, billing, consent, or purchased
membership terms.

## Commands and evidence

The guarded apply/replay runner is:

```text
node scripts/import-bnms-final-members.mjs --allow-existing-regional-rules --apply --review-sha256=5f4dbbc4e10d2adf8e3789d7954f9443f85ff80ec6099e3ff5f15a282f3256c7
node scripts/import-bnms-final-members.mjs --allow-existing-regional-rules --apply --review-sha256=5f4dbbc4e10d2adf8e3789d7954f9443f85ff80ec6099e3ff5f15a282f3256c7
node scripts/export-bnms-final-exceptions.mjs
```

Private evidence is under `exports/bnms-final-import/`, including
`result.json`, `replay-result.json`, and `BNMS-private-exceptions.xlsx`.
The workbook contains the 30 original conflicts, both exclusions, any newly
blocked rows, and a reconciliation of all 79 source rows.

## Safety and verification

The runner is pinned to the workbook fingerprint, destination project, BNMS
tenant, reviewed live schema hash, and exact 47-row cohort. It uses verified
TLS, locks before fresh identity checks, durable pre-write identity journaling,
one transaction, readback verification, and a zero-write replay. Imported
members were verified with login and directory visibility disabled, no role or
identity links, and no inferred creation date. Pre-existing managed data was
verified unchanged outside the authorized regional-rule effects.

At least 29 isolated source, validation, read-only, importer, and workbook
checks pass. The workbook is generated with ExcelJS and independently read back
with SheetJS, comparing every cell and rejecting formulas.

All source workbooks and operational reports contain personal data and remain
git-ignored with owner-only permissions. Historical caveat: the source workbook
was already present in an inherited shared checkpoint before this task. This
work did not rewrite shared history or purge external caches.
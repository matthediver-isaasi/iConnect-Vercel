# BNMS expiry date correction

Completed 2026-09-20 against production DEST Supabase project
`lvmzliemqnieeoruhkik`, BNMS tenant only. SOURCE was not used.

- Workbook SHA-256: `811de006424954fa68809d1bcd6f87f8e7975c7efa9f98e3c0a08592dc8206db`
- Scope: 227 distinct workbook member UUIDs; only the text preference
  `ym_date_membership_expires` (`2f04cda8-33f9-4df4-bcd5-e7150e4ca9ae`).
- Conversion: explicit US m/d/yy to zero-padded DD/MM/YYYY, preserving the
  actual source years 2024–2027.
- Updated: **227**. Initially unchanged: **0**. Blocked: **0**.
- Post-commit verification: **227/227** expected values.
- Independent dry-run replay: **0** writes, **227** unchanged, **0** blocked.
- Core member data (excluding automatic `updated_at` refresh) and all other
  preference rows were compared inside the transaction and unchanged.
- No inserts, core membership-date writes, billing calls, email calls,
  access-setting writes, or schema migrations were performed.

## Recovery evidence

Protected evidence is outside Git and public assets, in:

`/home/runner/.private-recovery/bnms-expiry/2026-09-20T12-21-43.697Z/`

Files: `before.json`, `after-before-commit.json`, `committed.json`.
Directories are created owner-only and files mode 0600. The before evidence
includes exact preference rows, workbook identity, member IDs, source and
desired values. Recovery must check current values against the committed
after-state and tenant/field identity before restoring any value; never
blindly overwrite intervening edits.

Independent replay evidence:
`/home/runner/.private-recovery/bnms-expiry/2026-09-20T12-21-49.794Z/`

An initial application attempt rolled back with zero changes because the
whole-row concurrency comparison detected timestamp representation differences.
The runner now retains PostgreSQL JSON timestamp representation and precision;
the PostgreSQL regression includes a microsecond timestamp.

## Repeatable checks

Dry run:
`node scripts/correct-bnms-member-expiry-dates.mjs`

Isolated tests:
`node scripts/run-isolated-tests.mjs --allow-local-postgres node --test scripts/correct-bnms-member-expiry-dates.test.mjs`

All three tests passed, covering ambiguous dates, actual year expansion,
invalid calendar dates, duplicate UUIDs, cross-tenant rejection, missing and
conflicting values, PostgreSQL compare-and-swap, rollback after partial
affected-row mismatch, and no-op replay.

Application requires `--apply --review-sha256=<current dry-run review hash>`.
Do not use general importers for this correction. No migration is outstanding.
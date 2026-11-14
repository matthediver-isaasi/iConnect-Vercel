# GFI Role Alignment configuration update

Applied directly to verified production DEST `lvmzliemqnieeoruhkik`.
No application deployment or schema migration is required.

- Added 24 Theme choices in source order, giving 30 total choices.
- All 25 current Theme labels are represented exactly, including the non-breaking
  space in “Postgraduates Taught & Research”.
- Owner explicitly approved changing the visible label “Employer engagement” to
  “Employer Engagement”. Its stored value remains “Employer engagement”.
- Other existing choices, all stored values, and every unrelated field property
  were preserved. The source category was unchanged.
- All four existing saved-answer rows had identical before/after digests.
- The only mutation was an options update guarded by field ID, tenant ID and
  original complete row, inside a serializable transaction with row locks.
- A second apply invocation was a no-op.
- No SOURCE queries or writes, member writes, role changes or synchronization
  feature were introduced.

## Recovery evidence

`gfi-role-alignment-before.json` contains the original complete field, original
category, proposed field, added choices and reviewed configuration hash.
`gfi-role-alignment-after.json` contains the committed read-back and verification.
Neither contains member answers or member identifiers. These small configuration
records are retained in version control, not as a general database backup.

Any recovery should be separately authorized and guarded against subsequent
edits. Do not blindly restore the full field or remove new options after members
have started selecting them.

## Verification

- `node --test scripts/update-gfi-role-alignment.test.mjs`: three tests passed.
- Live transactional assertions and independent post-commit read-back passed.
- `node scripts/update-gfi-role-alignment.mjs --apply` after completion:
  `applied: false`, `added: []`.
- Authenticated production UI was not available and was not verified.
  The legacy SOURCE workspace preview is not production evidence.

This runner is a one-time maintenance tool, not a scheduled synchronizer.

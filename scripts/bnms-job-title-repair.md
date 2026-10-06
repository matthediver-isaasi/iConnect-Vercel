# BNMS job-title repair operations

This is a destination-pinned, BNMS-only operation, not a general import.
Never run historical import scripts or Import Manager to apply the returned
workbook: those paths can create members and overwrite unrelated fields.

## Private evidence

`private/bnms-job-title-audit/` is Git-ignored. Files are written with mode 0600
inside a 0700 directory. Do not move these files into public assets, source
control or public object storage. Keep the original snapshot, reviewed manifest,
source matches, schema evidence, transaction journals and receipt together.
Source input hashes in the evidence identify the retained historical CSVs; the
historical import identity/hash contracts are unchanged.

`audit-bnms-job-titles.mjs` performs a repeatable-read, read-only audit of every
BNMS member, including inactive members, with stable UUID pagination and an
exact count reconciliation. It never replaces an existing snapshot.
The separately reviewed manifest binds every nonblank decision to an exact
member UUID and current value. Header names or text length never authorize a
cleanup. Ambiguous mixed descriptions and source mismatches stay unchanged.

## Cleanup

```
node scripts/run-bnms-job-title-repair.mjs cleanup PRIVATE_MANIFEST.json REVIEWED_JSON_HASH
node scripts/run-bnms-job-title-repair.mjs cleanup PRIVATE_MANIFEST.json REVIEWED_JSON_HASH --apply
```

The hash is SHA-256 of `JSON.stringify(parsedManifest)`, not of pretty-printed
file bytes. The retained private summary/manifest has the reviewed hash.
Only individually confirmed note-only values are cleared; original content is
preserved verbatim in a deterministically identified note with null human
author and explicit automated provenance. This does not claim the member
authored a new note. Existing notes are untouched.

The apply is one serializable transaction with row locks, exact full-row stale
checks, reviewed-schema checks, automatic-rule configuration locks, checked
readbacks and independent committed reads. Note insertion and title removal are
atomic. Replay verifies the existing note and resulting title and performs no
further writes. Normal member triggers update `updated_at` and increment
`survey_invitation_revision`; all other member columns must remain identical.
Enabled Job Title automatic-group rules stop the operation for further review.
The cleanup verified all BNMS group records were unchanged.

## Return the workbook

Edit only **Corrected job title** in **Job titles**. Leave other cells unchanged.
A blank or whitespace-only correction means **no change**, not deletion.
Return the XLSX through the private project; no CSV conversion is required.
Actual manual corrections must not be applied until the user returns the file.

```
node scripts/run-bnms-job-title-repair.mjs returned PRIVATE_MANUAL_MANIFEST.json REVIEWED_JSON_HASH --file RETURNED.xlsx
# Inspect the dry-run count and private workbook before explicitly applying:
node scripts/run-bnms-job-title-repair.mjs returned PRIVATE_MANUAL_MANIFEST.json REVIEWED_JSON_HASH --file RETURNED.xlsx --apply
```

The original private manual manifest, not editable spreadsheet metadata, is the
authority for UUIDs and before-state. Duplicate, unknown or off-tenant UUIDs,
changed identity columns, formulas, hyperlinks, unexpected sheets/columns and
stale member records are rejected. Corrections update only Job Title plus normal
trigger metadata. They never create members. A receipt verifies exact replay.
If a stale check fails, obtain a fresh private snapshot and review the conflict;
do not refresh the manifest blindly or substitute another member ID.

## Recovery

The `*-before-*` journal is saved before mutation; `*-precommit-*` records exact
after-state and inserted notes before commit. A committed receipt is written
only after independent verification. If a post-commit verification fails,
inspect these records before retrying. Do not assume an error implies rollback.
Any rollback needs a separately reviewed, tenant-scoped transaction verifying
that current rows still match the recorded after-state, restoring only the
recorded title and removing only the exact inserted note if explicitly approved.
Do not overwrite subsequent manual edits or restore whole member rows.

## Verification

```
node --test scripts/bnms-job-title-repair.test.mjs scripts/bnms-job-title-repair.postgres.test.mjs
```

The PostgreSQL suite starts an isolated disposable database; it does not use
DEST or any live members. No database migration is required by these tools.

# GFI AHECS member import

Completed 2026-10-02 against verified production DEST project
`lvmzliemqnieeoruhkik` only. SOURCE was neither connected to nor modified.

## Reconciliation

| Outcome | Rows |
| --- | ---: |
| Workbook records | 17 |
| Created | 17 |
| Pre-existing email matches | 0 |
| Blocked | 0 |
| Failed | 0 |
| Post-commit verified | 17 |
| Additional writes on replay | 0 |

All supplied names, normalized emails and organisation links matched the saved
rows. All 11 supplied organisation UUIDs and labels matched GFI.
The live tenant name was independently verified as Graduate Futures Institute.
Exactly one tenant-scoped AHECS role was found:
`18533de9-32d1-427a-8be9-d37954ad416c`, a non-admin role without a capacity limit.
All imported rows have that role, `login_enabled=true`,
`show_in_directory=false`, `is_guest=false`, `status=active` and no direct
organisation-group assignment.

Login enablement is permission to log in, **not** an invitation or password
provisioning operation. No invitations, welcome emails, credentials, communication
preferences, billing records or membership terms were created by this runner.
Existing members were unchanged.

## Safety and verification

- Original workbook SHA-256:
  `db23252a5e62963fa575087c1a27aa85023f71fc93e681ae77a0d6a27fc4bcc1`.
- Import runner: `scripts/import-gfi-ahecs-members.mjs`.
- Reviewed plan SHA-256:
  `f4a90044c4f9f614673d93322774e76ecd7218ed99bee7fd82cb29b6ba873b16`.
- Guarded transaction used explicit DEST project identity, verified TLS, table
  locks, parameterized inserts and unchanged schema/configuration fingerprints.
- Live member insert triggers and their called functions were inspected. Capacity
  and tenant checks remain active. Automatic-group queueing had no eligible GFI
  groups; all active GFI workflows were field-change workflows. No triggers were
  disabled and no generic import endpoint was invoked.
- Existing GFI members were compared exactly before commit. Communication
  preferences, workflow logs/claims/outbox, login revocations and member groups
  retained identical counts and fingerprints.
- Independent post-commit cohort read passed at 10:08:43 UTC; an actual repeat
  execution passed at 10:09:00 UTC with zero writes and 17 verified imported rows.
  No unrelated member-count change was observed across either post-commit read.
- Four offline tests passed with
  `node --test scripts/import-gfi-ahecs-members.test.mjs`.
- No application/UI code changed; browser testing is not evidence for this
  operational import.

## Private evidence

The original workbook is retained locally and ignored by Git. Row-level plans,
catalog snapshots and reconciliation evidence are retained under ignored
`private/gfi-ahecs-members/`, with restrictive file permissions.
The workbook and private evidence were absent from the Git index; the workbook
had no reachable `git log --all` history at the final pre-completion check.
This is not a claim that external backups or platform-retained copies are purged.

The runner defaults to a read-only dry run. Applying requires the exact private
plan hash; input bytes, runner, tenant, role, schema and configuration are pinned.
Do not replace a reviewed plan to bypass a drift failure. Replay preserves
pre-existing accounts and verifies the original created cohort without inserts.

## Migrations

No database migration was needed or applied to DEST, SOURCE or any other
database. None remains outstanding for this import.
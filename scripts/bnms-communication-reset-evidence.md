# BNMS communication subscription reset — 2026-09-28

## Authorized destination and result

Completed against production DEST project `lvmzliemqnieeoruhkik`, tenant
`ff2df806-b321-4254-b651-3af11fccf1db` (live name BNMS, slug bnms).
The originally supplied tenant ID did not exist; the user explicitly approved
the live replacement before any write. SOURCE was never used.

This was a one-time data repair, not a policy/default change. No schema
migration was needed, applied, or remains pending. No email was sent by the
repair. Provider suppressions were not accessed or bypassed.

| Measure | Before | After |
|---|---:|---:|
| Non-deleted members covered | 3,799 | 3,799 |
| Disabled accounts among those members | 48 | 48 |
| Global member opt-outs | 2 | 0 |
| Explicit true eligible category pairs | 14 | 8,451 |
| Matching global ledger suppressions | 2 | 0 |
| Matching eligible category suppressions | 11 | 0 |

Added 8,429 preference rows and changed 8 existing preferences to true.
All 8,451 eligible member/category pairs were independently checked in SQL.
The communications status report's shared row builder produced matching totals.

| Category | Eligible subscribed members | Normal member audience* |
|---|---:|---:|
| Society Admin | 853 | 853 |
| Newsletter | 3,799 | 3,751 |
| BNMS Updates | 3,799 | 3,751 |

*Read-only calculation using the existing active-member/global-consent helper;
this is not a promise of provider delivery or a campaign preview. Disabled
logins remain excluded from normal delivery. Other delivery checks remain intact.

## Exclusions and invariants

- 116 deleted/anonymized placeholders unchanged.
- 2 orphaned preferences with null member references unchanged.
- 33 suppressions for historical rather than current member emails unchanged.
- No missing member emails, duplicate normalized-email groups, overlapping
  external subscribers, cross-tenant inconsistencies, or unresolved exceptions
  in the reviewed live target.
- No new preferences for inaccessible categories. BNMS had three active,
  member-enabled categories; Society Admin was restricted by role.
- Member protected-field hashes, excluded preferences and ledger rows,
  categories, assignments, and external subscribers matched their before-images.
- Transactional before/after fingerprints matched for other-tenant members,
  preferences and suppressions, and for all external subscribers, roles,
  member groups, campaigns and campaign recipients.
- Deployed consent RPC bodies matched the reviewed migration source.
  Trigger inspection found no direct send operation; no BNMS automatic group
  depended on the changed global-consent field.

## Verification and recovery records

The reviewed apply hash was
`57f11ddd9fe4772a29ab221c906f29e590c9edb0e8be40e7c29b30bcb884ce04`.
All changes committed in one serializable transaction using existing
tenant/normalized-email advisory locks and deployed consent RPCs.

Independent SQL checks both before commit and in a new read-only transaction
found zero global mismatches, missing/false eligible pairs, matching global
suppressions, or matching eligible-category suppressions. A separate repeat
dry-run also found **zero changes**.

Private review manifests, before-images, after-images, and the commit receipt
are outside the repository at:
`/home/runner/.private-data-repairs/bnms-communication-reset/`
(directory mode 0700, files 0600). They contain personal data and must not be
copied into public assets or checkpoints. They are workspace-local recovery
records, not an independently backed-up archival service.

Recovery is deliberately not automatic: compare the receipt's after-image to
current rows first, and reject later preference changes rather than overwriting
them. Restore only the affected global flags, changed preferences and deleted
ledger rows; remove only the repair-created preference IDs. Use the same
identity locks in one explicit transaction. Never restore full member rows.

## Isolated tests (not live test writes)

```
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  scripts/lib/bnms-communication-reset-plan.test.mjs \
  scripts/bnms-communication-reset.postgres.test.mjs \
  shared/communicationCategoryMembership.test.mjs
```

19 tests passed. Coverage includes roleless/restricted/public-only/inactive
categories, scalar/array roles, disabled/deleted/missing-email members,
duplicate identities, orphan and historical rows, tenant isolation, atomic
rollback, replay, concurrent preference-writer blocking, and subsequent normal
user opt-outs. PostgreSQL fixtures use a disposable local socket database, not
DEST or SOURCE. No application/UI change or browser verification was required.

The runner defaults to read-only `--dry-run`. Applying requires the exact
review hash of the current implementation, database target, consent contract,
and reviewed snapshot. It is not registered in application startup or any cron.
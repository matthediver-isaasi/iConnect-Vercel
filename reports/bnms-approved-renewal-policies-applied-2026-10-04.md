# BNMS approved renewal-policy application — 4 October 2026

## Authorization and result

The operator separately answered **“Authorize the scoped DEST writes”** to:
“Do you authorize DEST writes for the exact 72 approved BNMS renewal-policy assignments?”
The stated scope included five record-scoped Full Overseas exceptions and excluded
shared schedule changes, rollout, recurring consent, charges and successor commitments.
This authorization is separate from the unchanged schedule-approval report.

**Applied atomically to verified DEST (`lvmzliemqnieeoruhkik`): 72 assignments.**
The 11 pre-existing assignments remained unchanged, giving 83 assignments overall.
An immediate replay matched all 72 assignments and performed **zero writes**, including
no repeated function replacement. SOURCE and the workspace runtime database were not modified.

| Cohort | New assignments |
|---|---:|
| Full UK | 37 |
| Junior UK | 13 |
| Trainee UK | 8 |
| Student | 4 |
| Associate UK | 3 |
| Full Overseas | 5 |
| Associate Overseas | 2 |

## Pinned evidence

- Approval report: `reports/bnms-legacy-renewal-schedule-approval-2026-10-04.md`
- Approval report SHA-256: `983c80dd969c7fe621684e2f0ec41fb6ec2c452e34f37f3f2356e28c67a2ad7c`
- Applied plan SHA-256: `5d3fc03da2d734281d59559db2d214b53c89f34bf3cfda4f3e4b7f69750046a0`
- Pre-application database contract SHA-256: `084371823be76028074619a4b078c7a928c848fc7dff7d269562eeaf91d9c685`
- Assignment guard before SHA-256: `9e8cbce4d3f29efd85d9b4193b1e4fed3ac5a4a385cc70019a2b185bbf1d2b95`
- Assignment guard after SHA-256: `bde4771e9cb420e2321464be4bcf3f89fca789c97e0de217ec3ac194ad39754a`

The permission-restricted, git-ignored directory
`private/bnms-renewal-policy-2026-10-04/` retains the hash-pinned plan, full historical
snapshots and configuration versions, full member-row hashes (not member personal
data), and rehearsal/application/replay evidence. Do not publish those private
operational files with application source. The plan includes exact history/member
bindings, original provenance, assignments and before/after exception definitions.

The first read-only plan was regenerated solely after tightening runner checks.
Every history/member/configuration binding, both guard definitions, existing
assignment and installed-contract fingerprint was verified identical to the first plan.

## Safeguards and verification

The destination-only runner is `scripts/apply-bnms-approved-renewal-policies.mjs`.
It verifies SQL and REST project identity with verified TLS. Application requires
the exact plan hash and unchanged source/report hashes. It rejects missing owners,
changed historical provenance, schedule/version drift, other-assignment drift,
partial or conflicting cohort assignments, changed database contracts and enabled rollout.

The shared schema advisory transaction lock coordinates with the separate migration
installer. Brief table locks prevent concurrent data changes during validation and
application. All 72 inserts and the five-record overseas exception are in one
transaction. The exception preserves the prior one-record exception and all
existing ownership, immutability, date, RLS and grant checks; it matches exact
history/member/expiry tuples, tenant, configuration, policy and approval reference.
It does not modify the shared Overseas schedule.

Successful DEST rehearsal executed all 72 inserts and the guard replacement,
verified the resulting rows, then rolled back. The authorized application then
committed successfully and a separate replay returned:

```json
{"inserted":0,"replay":true,"writesPerformed":false,"historiesUnchanged":true,"rolloutEnabled":false}
```

Full before/after row equality was checked for every approved history and schedule.
Whole-table count/fingerprint equality additionally covered:

| Protected table | Rows before and after |
|---|---:|
| member | 11,065 |
| member_membership_history | 963 |
| membership_tier_config | 27 |
| membership_billing_agreements | 388 |
| membership_successor_election | 0 |
| membership_successor_payment_attempt | 0 |
| membership_successor_rollout | 1, disabled |
| membership_successor_tenant_rollout | 0 |

Historical commencement, expiry, amounts, payment classification and source
provenance were preserved exactly. No providers were called. No payment, recurring
consent, successor commitment, member login or role change was created.

Disposable PostgreSQL tests cover final-insert failure rolling back preceding
inserts **and DDL**, full-batch success, zero-write replay, history/configuration
drift, lost tenant ownership and rejection of a sixth unapproved overseas record.
These are database operational checks, not browser/payment-provider acceptance.

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  api/_lib/expiryOnlyRenewalPolicy.postgres.test.mjs \
  api/_lib/expiryOnlyRenewalPolicy.test.mjs \
  scripts/lib/expiry-only-migration.test.mjs \
  scripts/apply-bnms-approved-renewal-policies.test.mjs
```

## Migration and rollout status

- `20261206_bnms_expiry_only_form_renewal.sql` was **already installed on DEST**
  before this application. Its installed capability, reservation integration,
  service-only access and disabled rollout were checked. It was **not reapplied**.
- A narrowly scoped assignment-guard extension for the five approved Full Overseas
  histories **was required and applied to DEST atomically by this runner**. No
  shared policy settings were changed; no separate broad safety migration was installed.
- **No outstanding migration is needed for these 72 assignments.**
- Renewal rollout remains disabled. Future payer-initiated renewal still requires
  current provenance, conflict, agreement, pause and election checks. These
  assignments do not authorize rollout or establish recurring consent.
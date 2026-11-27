# Guest association multi-value filter installation

## Result

Owner-approved schema-only installation completed on 2026-11-27 against DEST
Supabase project `lvmzliemqnieeoruhkik` (`iconn-multi-tenant`, `eu-central-1`).
The project reported `ACTIVE_HEALTHY`. Both configured DEST REST and SQL target
identities matched the pinned project; execution used the configured Supabase
managed migration connection, not SOURCE or the workspace application's database.

- Source: `supabase/migrations/202612090014_registration_association_multi_values.sql`
- Reviewed SHA-256: `e5653bea10799ba958a3aa871df49d39ee967b73ca1fdca47ca8da5214eed49d`
- Rollback rehearsal journal: `20261127130429`, `registration_association_multi_values_rollback_rehearsal`
- Committed installation journal: `20261127130444`, `registration_association_multi_values`

**Do not replay the source migration.** It patches the preceding scalar lookup
definition and deliberately rejects an already-installed extension.
Do not run `scripts/apply-registration-association-migrations.mjs`; that runner
only installs the initial association schema and is not an upgrade path.

## Approval and verification boundaries

The owner explicitly approved the target, prerequisite inspection, rollback
rehearsal, reviewed-hash installation, service-only verification and read-only
event checks. The owner then requested: “I will check manual, please ignore this
step.” Accordingly, **event discovery/search checks were not performed**. No
event was selected or inferred for testing.

This was not an application deployment or an authenticated UI test. Matching
editor/API rollout remains separate. No registrations, event settings, member
accounts, booking attempts, checkout, payments, email or provider operations were
created or altered. SOURCE was untouched. The only persistent changes were the
reviewed functions/grants, schema reload notification and managed migration
journal entries. No separate backup or restore test was performed or claimed;
the actual-target transactional DDL rollback was rehearsed.

## Safeguards used

`scripts/registration-association-multi-values-release.mjs` is an offline-only
payload builder. It never connects to a database. Its default output describes
the artifact without generating executable installation SQL. Every executable
mode requires the exact `--approved`, `--review-sha256` and `--mode` arguments.
The pinned project in its payload must also be checked by the managed executor.

Before either rehearsal or installation, the guarded transaction:

1. Obtains the existing association-schema advisory transaction lock with bounded
   statement and lock timeouts.
2. Rejects an existing multi-value helper.
3. Matches the exact lookup body derived from the initial association migration
   plus the value-scope, complete-list and Zombie-exclusion extensions through
   `202612090011`; also checks its security context.
4. Checks the scalar matcher, both JSONB settings columns and enabled config
   guard triggers.
5. Snapshots definitions and grants of the scalar matcher, config guard,
   association validator, account provisioning and booking batch functions.

Separate read-only prerequisite inspection also confirmed the account provisioning
association validator, batch association-role guard and unpaid Invoice/PO evidence
logic. No historical prerequisite migration was replayed.

The rehearsal runs the reviewed extension and checks inside a PL/pgSQL exception
subtransaction, then deliberately rolls it back. It subsequently rechecks the
original lookup and absence of the helper. Its migration journal entry records
the rehearsal, not a persistent feature installation.

The committed transaction installs only the reviewed extension and verifies:

- Exact new lookup and helper bodies and execution contexts.
- No PUBLIC, `anon` or `authenticated` execution grants; service execution allowed.
- Actual `anon`/`authenticated` calls denied with insufficient privilege.
- Service-role matching of synthetic strings/arrays and rejection of empty or
  malformed value lists.
- Service-role execution reaches the lookup's NULL-argument validation without
  reading any event.
- All snapshotted existing function definitions and grants remain unchanged.

An independent **read-only** post-commit verification repeated the exact
definition, grant, actual-role and synthetic matcher checks successfully.
Managed migration history independently confirmed both recorded versions.

## Offline verification

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  scripts/registration-association-multi-values-release.test.mjs \
  scripts/registration-association-multi-values-release.postgres.test.mjs \
  api/_lib/eventRegistrationAssociations.test.mjs \
  api/_lib/publicTicketMemberCreation.postgres.test.mjs

node scripts/run-isolated-tests.mjs node --test \
  client/src/components/booking/RegistrationAssociationField.mounted.test.mjs
```

All 23 focused tests passed across the completed runs: five payload guards, one
disposable release integration, seven API-helper cases, one full disposable
booking-policy integration and nine mounted editor/picker cases. The disposable
release test verifies rollback, installation, role denials, read-only checks,
replay refusal and changed-helper rejection. Its provisioning functions are
inert stubs; the separate full booking-policy integration exercises the real
provisioning migrations in disposable PostgreSQL.

These tests are not evidence of live event search, signed-in UI behavior,
account creation or checkout.

The workspace root preview was also inspected and still displays the documented
`Public API Error (404): Tenant not found` from its existing tenant configuration.
It does not verify the DEST installation or signed-in UI. No application runtime
code or preview database configuration was changed for this schema-only task.

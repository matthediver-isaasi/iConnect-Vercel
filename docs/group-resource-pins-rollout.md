# Independent group resource pins

Group pins use `resource.is_group_pinned`, independently of the tenant-wide
`is_pinned` flag. Both default to false when absent from legacy read results.
Only group-owned resources can receive group pin priority, and neither flag
gives a group-owned resource priority in the main resource library.

## Schema installation boundary

`supabase/migrations/202702080002_resource_group_pins.sql` is prepared but **not
installed on any shared or production database** by this task. Obtain separate
owner approval before applying this single migration to the intended database.
Do not replay the migration directory. No backfill or content change is needed.
The group pin action returns a visible error if the column is unavailable;
ordinary reads treat a missing field as unpinned.

Merge/release the application code separately. No deployment was performed.

## Write boundary

`PATCH /api/resources/group-pin` accepts only `id` and boolean
`is_group_pinned`. It checks the persisted resource's tenant and owning group,
then uses the existing active-group-administrator/tenant-administrator boundary.
The update is constrained to the same persisted owner. Linked tenant resources
and ownership/global-pin fields are rejected. Generic editor saves strip pin
snapshots so ordinary editing cannot reset either editorial decision.

## Verification

Run server/persistence regressions without shared service access:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test --test-concurrency=1 \
  api/_lib/groupResourcePins.test.mjs api/_lib/resourcePins.test.mjs \
  api/public/member-group-content.test.mjs client/src/lib/resourceQueryOptions.test.mjs \
  scripts/group-resource-pins.postgres.test.mjs scripts/resource-pins.postgres.test.mjs
```

Run the real route components with isolated browser auth/transport:

```sh
npx playwright test --config=tests/group-resource-pins.config.mjs
npx playwright test --config=tests/resource-pins.config.mjs
```

These tests do not demonstrate installation on a shared database or signed-in
live-tenant operation. The workspace application starts, but its normal preview
reports **Tenant not found**; the signed-in live UI and live schema were not
verified. The migration and successful writes were tested on disposable local
PostgreSQL only.

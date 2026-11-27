# Shared resource card pins

## Release boundary

`supabase/migrations/202702080001_resource_editorial_pins.sql` is prepared and
tested on disposable PostgreSQL. **It has not been installed in any shared or
production database.** Installation requires separate owner approval.

Apply this one migration to the explicitly approved target before rolling out
the corresponding application code. Do not replay the migration directory.
It adds one non-null boolean column, default false, to `public.resource`.
There are no provider operations, publication changes, or content/date changes.

The guest library uses an explicit projection containing the new column.
Without the migration that request fails, rather than silently treating a
partially installed feature as successful. Pin saves return an explicit 503
when the schema is unavailable. Authenticated `select('*')` reads carry the
column once installed. Legacy absent client values are treated as unpinned.

## Authority and ordering

- `PATCH /api/resources/pin` accepts a resource id and boolean `is_pinned`.
  It requires authenticated, tenant-scoped resource-management access or
  administrator access, and excludes group-owned resources.
- It updates only the pin field. Generic create/update saves strip editorial
  pin snapshots to avoid overwriting a newer decision. Lower-privilege attempts
  to change that field are rejected; unchanged round trips are stripped.
- Management offers the only controls. Browsing has no editorial controls.
- Both route components apply a stable partition to existing filtered/sorted
  matches before pagination. No showcase, Canvas, group-list, bookmark,
  availability, category, or release rule was changed.
- A successful action resets management to page one and invalidates management
  and browsing caches. There is no optimistic pinned state on failed saves.

## Verification

Focused tests:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test --test-concurrency=1 api/_lib/resourcePins.test.mjs scripts/resource-pins.postgres.test.mjs api/public/resource/release-list.test.mjs
npx playwright test --config=tests/resource-pins.config.mjs
```

The focused checks passed: eight API/ordering/projection/database tests and six
isolated browser tests using the real Management and Resources components.
Database tests install the migration on a temporary Unix-socket PostgreSQL
cluster and exercise the pin action against persisted rows. Browser tests
mock transport/authentication only and cover guest/member sorting, excluded
matches, deep-linked searches, multiple pins across pages, management reload,
unpinning, ordinary edits, and failed saves.

An additional regression run passed 42 of 46 tests across resource access,
category visibility, form targets, and release helpers. Four pre-existing
failures in `api/_lib/resourceReleaseSecondary.test.mjs` concern AI release
boundaries, live hydration, prerender ordering, and secondary cache policies;
their application files are not changed here.

The older `tests/resource-release.task4691.spec.mjs` suite failed before running
its browser cases because its mocks lack current exports:
`getTenantSlugFromLocation`, `getActiveTenantId`,
`subscribeToActiveTenantId`, and `usePageLayoutDecision`. The dedicated pin
browser suite passes independently.

The development workflow starts cleanly on port 5000. An unauthenticated
preview of `/Resources` displayed “Tenant not found”; no valid tenant/session
was available for a real signed-in preview. That is not a passed end-to-end
installation or authenticated UI check. No live tenant data or schemas were
changed to work around it.

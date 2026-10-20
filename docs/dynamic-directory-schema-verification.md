# Dynamic Directory schema verification

Verified on 2026-10-20 against destination Supabase project
`lvmzliemqnieeoruhkik`, not the workspace's legacy SOURCE.

## Confirmed mismatch and repair

- `organization.city` and `organization.country` do not exist. Removed both
  from the full directory selection and OR search; subtitle is now `null`.
- `organization.slug` also does not exist and remains excluded. The directory's
  own slug is supported. Organization identity remains its ID.
- `member.linkedin_url` **exists** and remains selected and returned.
- No address fields were substituted, no publication rules changed, and no
  tenant configuration, eligibility values, or records were edited.

## Independent catalog contract

`api/public/directory-schema-contract.mjs` records the verified query dependency
subset for organization, member, dynamic_directory, preference_field,
organization_preference_value, member_preference_value, system_settings, and role.
The catalog was read independently of fixture rows. Selected columns, equality,
IN, NOT, OR search and ordering references are checked before row evaluation.
The canonical portal comparison in the carousel suite deliberately retains its
separate mock: its Custom Object graph is outside this embed loading repair.

The audit includes full member names/contact eligibility predicates, directory
slug/active/tenant lookups, inclusion expression field ownership and values,
custom-filter values, organization-name lookup, display settings, role badges,
and final inclusion/publication reads. `SELECT *` metadata consumers retain
their compatibility behavior; the catalog also confirms preference metadata
such as directory_visibility, is_filterable, options, and display_order.

Carousel direct-path dependencies are exercised with the same checked fixture.
The installed `organization_carousel_snapshot` function body exactly matches
`202610190002_organization_carousel_snapshot.sql`; executing it for the zero UUID
tenant successfully plans and executes all underlying queries without reading
real tenant records. The resulting empty snapshot passes the application adapter.
Handler tests compare snapshot versus direct output and test final-pass revocation.

`dynamic_directory.public_carousel_enabled` is absent at this destination.
Existing `SELECT *` and SQL `to_jsonb` access intentionally treat it as unset;
guest carousel access stays default-off. This is not a reason to add the column
or opt in any directory as part of this repair.

Reproduce the read-only destination checks:

```sh
node scripts/verify-directory-schema.mjs
```

The runner pins destination identity, uses verified TLS, opens a read-only
transaction, prints schema facts only, and rolls back.

## Test evidence and limits

- 105 focused Node tests passed:
  `node scripts/run-isolated-tests.mjs --shell 'node --test api/public/dynamic-directory*.test.mjs api/_lib/organizationCarouselSnapshot*.test.mjs api/_lib/directoryConfig.test.mjs api/_lib/directoryExpression.test.mjs'`
- Existing carousel browser run: 28 passed, one failed. The failure is the
  Back-navigation exact request-count assertion (3 requests rather than 2);
  its preceding assertions that denied cards/private metadata are hidden passed.
  A targeted retry reproduced it; no request-lifecycle code was changed here.
- Four added full-directory browser checks passed: member and organization
  loading and search in both the editor and logged-out public renderer.
- Browser fixtures intercept API responses, not live tenant data. Carousel
  ID-based detail actions, consent denial and member/organization paths passed.
  Full guest directory cards have no popup action by design; this is unchanged.
- Browser command:
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(which chromium) npx playwright test --config=playwright.directory-carousel.config.mjs`
  Use `--grep 'full dynamic directory'` for the four new checks.
- The unmodified local preview displays “Tenant not found” against legacy SOURCE.
  This does not verify a signed-in destination tenant or the live GFI page.
- No deployment was performed. The corrected build is not yet available on
  GFI's public partners page, so post-merge/deployment verification remains a
  rollout check, not a claim made by these fixture tests or catalog reads.

## Migrations

No migrations are needed for this query repair. None were applied to DEST,
SOURCE, or any other database, and none remain outstanding for this repair.
The existing snapshot migration was verified, not reapplied. The separate
carousel-consent rollout is unchanged.

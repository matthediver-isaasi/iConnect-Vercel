# Organisation directory exclusions verification

## Destination and deployed observations — 2026-09-16

Read-only checks against the destination Supabase project confirmed BNMS has
one `org_directory_excluded_orgs` row, containing:

- `7f16328d-e692-4671-873a-453464071eef` — Zombie Organisation
- `efa4d302-9ceb-4085-9e38-8510c16d8206` — British Nuclear Medicine Society

Both IDs belong to BNMS. The status/type settings also each have one row.
No tenant settings or organisation records were changed.

Before the repair, the current service returned 279 organisations for an admin
without an own organisation, excluding both saved IDs. Using either excluded
ID as the viewer's own organisation returned 280, including that organisation.
After the repair, name searches for each excluded organisation return zero,
including when it is the viewer's own organisation.

The domain read from the destination tenant was `60-years-of.bnms.org.uk`.
Its `/OrganisationDirectory` HTML referenced `/assets/index-cNl61iFK.js`.
That downloaded bundle did not contain `organisation-directory/filters`.
GET `/api/organisation-directory/filters` returned Vercel `404 NOT_FOUND`,
not the current handler's unauthenticated 401 response. Thus this deployment
does not expose the current authoritative route. No authenticated deployed
directory response was available, so the exact older-code behavior for both
reported cards was not asserted.

## Scope and verification

Only explicit exclusion precedence changed. Own-organisation status/type
exceptions remain. Search, totals, source options and CSV share the corrected
eligible population. The administrative entity API and its
`skipDirectoryFilters=true` CRM bypass were not changed. Existing settings
success invalidates the `organisation-directory-filters` query family.

Passed:

- 40 service/API tests:
  `node --test api/_lib/organisationDirectoryFilters.test.mjs api/_lib/organisationDirectoryFilters.integration.test.mjs api/organisation-directory/*.test.mjs`
- Three real-page Playwright tests backed by the actual directory service and
  a stateful in-memory database:
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(which chromium) npx playwright test tests/organisation-directory-filters.spec.mjs`
- Read-only destination service checks for both excluded own-organisation IDs.

Browser fixtures do not test production authentication or the generic CRM
handler: they verify the settings picker still requests the administrative
bypass and retains excluded records, while real service tests cover directory
eligibility. The unauthenticated preview renders its sign-in message; its
legacy source database cannot resolve the destination tenant.

## Rollout pending

Deploy the updated application through the existing Vercel release process,
then check the BNMS authenticated route, settings save/revisit, both excluded
cards, options and export on that deployed build. A source change alone does
not repair the older custom-domain deployment.
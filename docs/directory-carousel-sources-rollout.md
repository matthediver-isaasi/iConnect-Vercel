# Directory Carousel sources and rollout

## Scope

The existing Canvas Directory Carousel supports primary Member and Organisation
directories and active dynamic directories of either entity type. Legacy
slug-only selections remain valid; new dynamic selections use a stable ID.
Source selection never grants guest access.

Public display is a distinct administrator-only permission. Primary directory
settings save this permission independently and immediately. Dynamic directory
management saves it with the directory. It defaults off and is independent of
activation, viewer-role lists, guest introductory text and field switches.
No existing full-directory or embed access contract is changed.

Member cards currently support names, permitted front-facing profile photos and
job titles. Other member profile/contact fields are not included. Organisation
cards retain the restricted name/logo/verified-domain contract; general website,
description, contacts and custom values are not exposed.

## Migration status

- Created: `supabase/migrations/202610190001_directory_carousel_public_consent.sql`.
- **Not applied** to any live database.
- Read-only preflight on 2026-10-19 verified DEST project
  `lvmzliemqnieeoruhkik`, using independently pinned REST/SQL identities and
  certificate-verified TLS. The consent column, singleton index and guards
  were absent.
- SOURCE and the workspace database were not migrated.
- No live directory was opted into public display. No production deployment
  was performed.

The migration adds only the dynamic-directory consent column, a unique identity
for the two new primary consent setting keys, and browser-role write guards for
these permissions/public dynamic sources. It does not backfill publication
consent or change unrelated setting identities.

## Approved rollout procedure

1. Obtain approval to apply the migration to DEST. The offline review command is:
   `node scripts/apply-directory-carousel-consent.mjs`.
2. Re-run `node scripts/apply-directory-carousel-consent.mjs --preflight`.
3. Apply only the reviewed file with
   `node scripts/apply-directory-carousel-consent.mjs --apply --review-sha256=<reviewed-hash>`.
   The runner has no SOURCE or generic-database fallback.
4. Release the matching server and client code together through the normal
   approved release process. Do not enable public consent before the migration.
5. Validate an administrator's save/reopen/revoke flow and an authenticated
   restricted-role visit on the deployed build. With separate publication
   approval, explicitly opt in only the intended directories and verify guest
   responses, field privacy and revocation. All other directories remain off.

## Operational behavior

Requests return at most 50 records. The complete eligible population is ordered
before paging; randomized ordering is seeded per mounted visit and remains
stable through navigation and resizing. It is probabilistic, not an exposure
quota or alternating-start guarantee. Inventories and publication authority
are rechecked before returning. Read failures, changed authority and scan
limits do not produce a successful truncated inventory.

The editor distinguishes stage-wide geometry from viewport full bleed.
Responsive page size, spacing, internal padding, height and typography follow
Canvas breakpoints. New blocks start with one mobile card, while legacy scalar
settings and authored overrides retain their meaning.

## Verification boundaries

Isolated API/component tests and disposable PostgreSQL tests use synthetic data,
not live directory rows. Browser fixtures intercept APIs and do not establish
deployed authentication or database behavior. The read-only DEST preflight
establishes migration readiness only, not production feature rollout.

Completed checks: 57 carousel/legacy API tests, 37 related directory policy
regressions, 7 consent boundary/API tests, 3 mounted consent-control tests,
2 migration-runner tests, the disposable PostgreSQL migration test, 14 carousel
component/helper tests, 8 new browser scenarios and all 9 existing carousel
browser regressions (including Sponsor Carousel). The production build passed.
The development workflow restarted cleanly.

The ordinary unauthenticated workspace screenshot shows “Tenant not found” for
the existing development tenant configuration. The signed-in live UI was not
verified; rendered carousel verification used isolated browser fixtures.

Run the focused server checks with:

```sh
node scripts/run-isolated-tests.mjs node --test \
  api/public/dynamic-directory.carousel.test.mjs \
  api/public/dynamic-directory.test.mjs \
  api/_lib/directoryCarouselConsent.test.mjs \
  api/directory-carousel/settings.test.mjs
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  supabase/migrations/directoryCarouselConsent.test.mjs
node scripts/run-isolated-tests.mjs node --import tsx --test \
  client/src/components/directory/PublicCarouselPermission.test.jsx
npx playwright test --config=client/src/components/canvas/directoryCarousel.browser.config.mjs
npx playwright test --config=playwright.directory-carousel.config.mjs
```

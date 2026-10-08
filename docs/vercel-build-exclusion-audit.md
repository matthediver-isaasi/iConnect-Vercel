# Vercel build exclusion audit — 8 October 2026

## Recovery baseline

- Original branch: `sweep` (unchanged by this audit).
- Local starting commit: `aa08aae0f4a5958675ebaa4a89be7534da14ff1d`.
- Locally recorded `origin/sweep`: `c3a9b9bbce40e8fbe11027230e387c2009ecd9b5`.
- Isolated audit branch: `build/vercel-test-exclusion-audit`.
- Vercel project: `prj_iPFlb9rOOVNVtbobMRR1vyV934lf`.
- Production deployment observed: `dpl_AbYMZRhiztvNpoRubQvoD5haAjrD` (READY, PROMOTED).
- Production deployed commit: `da87d06c132ae66938fbd9ed69bf8415a329d326`, from `sweep`.
- Configured automatic production branch: `main`.
- Production is a promoted deployment, not the newest commit on `sweep`.

Recheck these live settings before pushing/promoting; this is a point-in-time baseline.
Git branch switching does not roll back Vercel production.
Do not force-push or overwrite `sweep`. Abandon this branch or revert its eventual
isolated exclusion commit to restore the previous packaging. For immediate
service rollback, use the recorded production deployment after confirming it
is still the appropriate recovery target.

## Proposed exclusions (not yet applied)

- `api/**/*.test.mjs`
- `api/**/*.spec.mjs`
- `api/public/formSubmissionCompatibility.helpers.mjs`

There are 715 tracked API test/spec files, all `.mjs`. 202 are outside
underscore-prefixed directories. The non-test-named compatibility helper imports
one of the test modules and is itself referenced by two tests only.
Exclude it with the tests to avoid leaving that dependency broken.

A static scan of literal imports, requires, URL-based and direct file reads in
API/server/shared/client code found no other non-test callers of these tests.
Searches for directory discovery found the local development API adapter;
this is not proof against every possible computed runtime file access.
Review the exact excluded manifest and remaining function inputs before release.

Tests remain in Git and locally available. Do not exclude all helpers, fixtures,
scripts or directories. Do not change TypeScript settings, dependencies,
runtime code, environment variables, routes or databases in this experiment.

## Verification before production

1. Apply only the approved exclusion configuration in an isolated commit.
2. Verify excluded files and retained endpoint/dependency inputs.
3. Confirm branch is preview-only before push; never automatically promote.
4. Compare preview build time and check representative pages/API routes.
5. Use non-mutating checks for payment, webhook and accounting services.
6. Get user approval before production promotion.

No exclusion configuration or live deployment changes were made during this audit.

# Website navigation continuity — verification and rollback

## Scope and baseline

Starting source revision: `3ffed212d07a99853836f18606d5be24d905c2a2`.
The working tree was clean before implementation. This baseline already contains
the session display-continuity fix and Due Diligence swap fix; neither should be
reverted when rolling back website navigation.

This is a frontend-only change. No database migrations, data repairs, campaign
changes, secret changes or production deployments are part of this work.
There is no database rollback to perform.

## Before releasing

1. Review the diff and record the exact commit(s) containing only this change.
   The starting revision is a comparison baseline, NOT a command to reset the branch.
2. Record the currently working Vercel deployment URL/ID for the target environment
   and its source revision in the release record. A source commit is not proof
   of which deployment a custom domain serves. No deployment reference was
   obtained during this local implementation.
3. Verify on the preview branch first: main-site and microsite page links,
   hidden-header/footer destinations, login/logout, back/forward and slow/error
   requests. Confirm the build identifier actually matches the candidate.
4. Obtain separate approval for production release. Keep the prior deployment
   available until the preview and deployed smoke checks are accepted.

## Rollback triggers

Roll back if navigation hangs, reaches the wrong page, crosses tenant/audience
boundaries, exposes excluded chrome, resets established forms during background
updates, or reintroduces session retry screens. Also roll back for broken
external links, downloads, modifier-clicks, or portal navigation.

## Source rollback without losing unrelated work

With a clean working tree, identify and inspect the isolated navigation commit:

```sh
git status --short
git log --oneline -- docs/website-navigation-rollback.md
git show --stat <navigation-change-commit>
git revert <navigation-change-commit>
```

Replace the placeholder with the reviewed commit, not the baseline revision.
For several isolated commits, revert newest first. A true merge commit needs
its parent structure reviewed before selecting the mainline; do not guess `-m`.
If the commit includes unrelated changes or a revert conflicts, stop and prepare
a narrowly scoped reverse patch for review rather than overwriting whole files.
Do not use `git reset --hard`, restore the entire baseline, or restore a database.

Run the focused regressions below, restart the existing application workflow,
and verify the preview. Publish the revert only with the owner's approval.

## Deployed recovery

For urgent recovery, the owner can restore the recorded prior working deployment
in the hosting dashboard. Confirm the selected environment and source version
before doing so: a deployment rollback also rolls back any unrelated code bundled
in that deployment. When that tradeoff is unacceptable, deploy the isolated
source revert instead. No hosting rollback was performed or rehearsed here.

After recovery, confirm the served build on the affected domain and test both
main-site and microsite navigation, login/logout, a header-free page and a form.
The old navigation spinner may return; the earlier session and form-swap fixes
should remain when using the isolated source revert.

## Verification commands and evidence

Baseline isolated tests passed: 27 request/session/navigation helper tests and
8 mounted route-layout/readiness tests.

```sh
node scripts/run-isolated-tests.mjs node --test \
  client/src/pages/dynamicPageRequest.test.mjs \
  client/src/pages/dynamicPageFirstLoad.test.mjs \
  client/src/lib/publicHeaderNavigationActions.test.mjs \
  client/src/lib/viewerProtectedWorkGate.test.mjs
node scripts/run-isolated-tests.mjs node --import tsx --test \
  client/src/contexts/RouteLayoutContext.test.jsx \
  client/src/components/layouts/PortalReadiness.test.jsx \
  client/src/components/navigation/PublicPageNavigation.test.jsx
```

The initial broad browser run overlapped frontend edits and is not a clean
before/after benchmark. Its sidebar cases also rejected the configured loopback
host in their network fixture. Final evidence is recorded separately below.
Fixture-based browser checks do not prove signed-in production behaviour or
production speed. No claim of improved production LCP is made.

### Final completed-code checks

- 40 isolated helper/mounted tests passed, including the new handoff tests.
- 20 session/sidebar browser tests passed; 11 deliberately retired session
  polling tests were skipped.
- 4 website browser tests passed: guest/member on main-site and microsite routes.
  Held destination responses retain the actual current header and URL; successful
  links issue one page request, hidden destinations never mount excluded chrome,
  errors remain recoverable, and auth/document request counts stay unchanged.
- The three modified application files passed reverse-patch applicability
  checking (`git diff -- <files> | git apply --reverse --check`), without applying
  a rollback. This is not a hosting rollback rehearsal.
- Application workflow restarted and served port 5000. The unmocked workspace
  screenshot still reports `Tenant not found` against its existing development
  database; signed-in/live-tenant UI was not verified. Browser evidence above
  uses isolated API fixtures, not production data.
- An additional legacy source-contract test in `layoutChromeReadiness.test.mjs`
  still fails because its Layout source-slicing marker no longer exists. Layout
  was not edited by this change. The passing mounted/browser checks above are
  the behavioural evidence; this is not a claim that every project test passes.

Browser commands:

```sh
PLAYWRIGHT_BASE_URL="https://$REPLIT_DEV_DOMAIN" npx playwright test \
  --config=tests/portal-session-boundaries.config.mjs
npx playwright test \
  --config=client/src/components/navigation/publicPageNavigation.browser.config.mjs
```

Use the explicit base URL for the session/sidebar suite so its request allowlist
matches the browser origin. Keep the suites' output directories separate.

### Deliberate limits

Only eligible ordinary same-origin links to dynamic website pages use the
request handoff. Modified clicks, downloads, external/new-tab links, query-bearing
URLs and other route types retain their existing handling. Direct entry and
browser-history navigation cannot prepare a request before activation and use
a neutral content placeholder where necessary. No speculative destination
header/footer is shown before its policy is known. This is a navigation
continuity improvement, not a guarantee of faster server responses.

# Website JavaScript splitting — verification and rollback

Baseline source: `ddba2800ee8a35eb6df0e8fa96dd7c1669979105`.
This is separate from the request parallelism and intent-navigation changes in
[website-navigation-rollback.md](website-navigation-rollback.md).

## Scope and boundaries

Administration, editor and reporting routes in `client/src/pages/index.jsx` now
use stable, module-level React lazy declarations. Named Custom Object exports
are adapted to lazy default exports. Existing route declarations, PAGES keys,
authentication gates and component-type policy comparisons are unchanged.
DynamicPage, HomePageRedirect, ViewPage and SmartLoginRoute remain policy owners;
the first three remain eagerly imported.

Public Canvas consumers use `LazyCanvasPageRenderer`, whose null Suspense
fallback encloses only the renderer, not the layout or the policy-owning page.
The dynamic article-editor branch also has a local null boundary. The existing
route error boundary retains stale-chunk recovery and explicit load failure UI.
Portal chrome/providers stay outside the existing route loading boundary.
No placeholder is counted as content. No session cache, request-authority,
form-swap logic or route policy was changed.

ButtonElements was an unexpected eager route into the entire Canvas registry;
it is now lazy too. Renderer and inspector definitions still share the Canvas
registry. Separating those internals is not required for these route boundaries.

No dependencies added, no deployment, no database writes or schema changes.
No migration is needed or pending for this change.

## Matched built evidence

Both builds used the same installed dependencies and Vite configuration:

```sh
npx vite build --outDir /tmp/website-split-baseline
npx vite build --outDir /tmp/website-split-candidate --manifest
node scripts/check-website-entry-budget.mjs /tmp/website-split-candidate
```

The baseline was built before application edits; its index asset is identical
to the previous investigation (`index-yT4ocLEd.js`). The final candidate is
`index-B2BJq1ZB.js`. A preliminary timing run overlapping compilation was
discarded; the reported runs were sequential, after builds completed.

| Measure | Baseline | Candidate |
| --- | ---: | ---: |
| Initial static JS graph, bytes | 15,040,275 | 6,468,666 |
| Initial static JS gzip, bytes | 3,760,998 | 1,614,103 |
| All local JS fetched through real Canvas content, bytes | 15,040,275 | 7,856,806 |
| Sum of gzip for those fetched assets, bytes | 3,760,998 | 1,997,016 |
| JS assets fetched through content | 1 | 20 |

Initial gzip is down 57%; all JS through actual content is down 48% raw / 47%
gzip. Gzip is calculated from files, not claimed as observed network encoding.
The budget script walks the manifest's **static import closure**, caps it at
9 MB, and ensures selected heavy routes and the Canvas renderer stay outside it.
Build warnings still include large chunks, shared static/dynamic registry
imports, and an existing duplicate FormManagement title attribute.

Serve the two outputs with `vite preview` on ports 5001 and 5002 respectively.
Run the existing navigation harness sequentially with
`PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port>` and
`FIRST_CONTENT_PHASE=baseline` / `candidate`:

```sh
npx playwright test \
  --config=client/src/components/navigation/publicPageNavigation.browser.config.mjs \
  --grep 'first-content critical path'
```

Three fresh browser contexts per entry, touch viewport 390×844, no CPU/network
throttle. All APIs intercepted; metadata/session responses delayed 300 ms,
page responses 500 ms. Actual paragraph visibility plus two animation frames
determines content time, not assertion polling. The harness records every JS
resource through that point as well as request timestamps. All samples assert
one document and one session read through cold, touch, Back and warm clicks.

Median milliseconds, baseline → candidate:

| Entry | Cold content | Bootstrap proxy | Touch | Back | Warm no-intent |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/` | 2517 → 1699 | 1603 → 675 | 603 → 602 | 540 → 542 | 567 → 556 |
| `/nav-a` | 2274 → 1331 | 1713 → 685 | 595 → 584 | 544 → 546 | 557 → 551 |
| `/branch` | 2607 → 1729 | 1685 → 712 | 602 → 595 | 542 → 540 | 554 → 553 |
| `/branch/nav-a` | 2094 → 1314 | 1537 → 664 | 579 → 587 | 546 → 533 | 553 → 551 |

Bootstrap proxy = first installed-fonts request, not an evaluation profile/LCP.
Raw cold samples:

- `/`: [2890,2517,2423] → [1699,1722,1692]
- `/nav-a`: [2191,2322,2274] → [1331,1340,1293]
- `/branch`: [2419,2612,2607] → [1691,3190,1729]
- `/branch/nav-a`: [2094,2050,2110] → [1314,1337,1312]

The 3190 ms outlier remains in the record. These are local controlled fixtures,
not production-speed guarantees. Warm differences are not meaningful speed
claims. Splitting introduces more requests and a first-use renderer dependency;
the measured cold improvement includes that cost.

## Regression verification

- Isolated mounted/unit checks: **35 passed**, covering route loading/error
  boundaries, lazy import guards, intent navigation, route layout, portal
  readiness, homepage failure and dynamic-page request/first-load policy.
- Built public browser suite: **19 passed**, including timing, guest/member
  main-site/microsite navigation, excluded chrome, hidden/error destinations,
  drafts, logout invalidation, and bounded request adoption.
- Built portal/session suite: **19 passed, 11 intentionally retired tests
  skipped**; one development-only test cannot import `/src/api/base44Client.js`
  from built assets. That test passed on the development server.
- Development portal suite: **20 passed, 11 intentionally retired tests
  skipped** in the final clean sequential invocation. An earlier cold module
  transformation exceeded the first content assertion timeout, and an
  overlapping targeted rerun removed a trace during final test cleanup.
  Targeted reruns and then the complete sequential suite passed.
- Due Diligence dashboard swap: **2 passed built + 2 passed development**,
  compatible confirmation and blocked invalid mapping. The config now accepts
  `PLAYWRIGHT_BASE_URL` so identical fixtures exercise built assets.
- App workflow restarted cleanly; `git diff --check` passed.
- Unauthenticated screenshot at `/Login` reached the explicit “Tenant not
  found” error from this workspace's backend. Live tenant/signed-in UI was not
  visually verified; fixtures establish browser behavior independently.

Commands for the mounted/unit checks:

```sh
node scripts/run-isolated-tests.mjs --shell 'node --import tsx --test client/src/components/routing/RouteLoadingBoundary.test.jsx client/src/components/navigation/publicPageIntent.test.mjs client/src/components/navigation/PublicPageNavigation.test.jsx client/src/contexts/RouteLayoutContext.test.jsx client/src/components/layouts/PortalReadiness.test.jsx client/src/pages/dynamicPageFirstLoad.test.mjs client/src/pages/dynamicPageRequest.test.mjs client/src/pages/HomePageRedirect.test.jsx'
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5002 npx playwright test --config=client/src/components/navigation/publicPageNavigation.browser.config.mjs
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5002 npx playwright test --config=tests/portal-session-boundaries.config.mjs
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5002 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(which chromium) npx playwright test --config=tests/dd-swap.config.mjs
```

## Rollback

Review the isolated splitting commit and revert only that commit after approval.
Do not restore the baseline tree or undo intent navigation, request parallelism,
session continuity or form-swap work. The application file set is pages/index,
DynamicPage, HomePageRedirect, ViewPage, layouts/PublicLayout, and the new
canvas/LazyCanvasPageRenderer. Include matching test/budget/document changes.
For an uncommitted rollback, preserve the complete diff and new files and
review a file-scoped reverse patch first. Re-run public, session and form-swap
checks. No database rollback is involved. No deployment was made; publishing
and live custom-domain verification require separate approval.

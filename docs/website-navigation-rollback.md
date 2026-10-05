# Website navigation intent-preloading correction — verification and rollback

## First-content request parallelism (2026-10-05)

This is a **separate, later correction**. Its clean application baseline is
`28bd673587d7945d5bbac2d2be804a9c855cbf92`. Do not revert the earlier intent,
session-continuity, or Due Diligence form-swap work to undo this correction.

### Critical path and changes

Inspection plus browser request timestamps established these paths:

| Surface | Baseline dependency | Change |
| --- | --- | --- |
| Main home `/` | branding + session → homepage slug → page → render | Start slug discovery alongside branding/session; page fetch and consumption still wait for their existing gates. |
| Main named page | public page request starts alongside branding, catalogue, article URL settings and session | Already parallel; no gate removed. |
| Explicit microsite page | catalogue → microsite branding; public page already starts early | Start the existing public branding query from the matched DynamicPage prefix, sharing its query key with the provider. Catalogue still establishes active site and chrome. |
| Bare microsite home | catalogue → actual home slug → scoped page | Unchanged: the URL does not provide the home slug. Existing preliminary bare-slug read remains. |
| Public page API | tenant → optional microsite → page row → viewer → symbols/elements | Page row and request-local viewer now run concurrently after tenant/prefix resolution. Both settle before response projection. |
| App bootstrap | document → eager route/module graph → providers and queries → content/render | Measured but not refactored. The large eager main bundle remains a substantial cost. |

Article URL metadata still runs independently. Its precedence checks, session
resolution and layout policy remain required before DynamicPage consumption.
No destination chrome is authorized by the early branding result. No public
loading bars/skeletons, session polling, persistent member response cache,
authentication shortcuts, database changes, migrations, campaigns, production
writes or deployments were introduced.

The homepage cache stores **only the public home slug**, using the previous
60-second lifetime and audience partition. It is now host/tenant-slug keyed,
not re-keyed when branding subsequently supplies an id. Its transport uses
`cache: no-store`. The page payload query and session gates are unchanged.
An intermediate mount-unique slug key caused repeated discovery after layout
remounts and slower Back navigation; that version was rejected and is not the
final implementation.

### Matched built-browser timing

Both sides were built with `npx vite build --outDir ...` using the same installed
dependencies/configuration, then served locally by `vite preview` on port 5001.
Baseline main asset: `index-Cp4r_bLv.js`, 14,995.28 kB (gzip 3,760.99 kB).
Final main asset: `index-yT4ocLEd.js`, 14,995.45 kB (gzip 3,761.00 kB).
There is no meaningful bundle-size improvement. Existing mixed static/dynamic
imports prevent several modules, including CanvasPageRenderer, from splitting.

Every API is intercepted, with 300 ms response delay for metadata/session and
500 ms for a public page. This holds server latency constant to isolate the
client changes; **the browser fixture does not exercise the API parallelism**.
Three fresh contexts per entry use a 390×844 touch-enabled viewport. Cold is
document navigation to the visible actual paragraph plus two animation frames.
A visibility-checked MutationObserver records the browser timestamp, avoiding
Playwright assertion-polling delay in the reported metric. Warm
means a subsequent same-document, no-hover/no-focus click; it is not a warm
HTTP-cache reload. Touch uses a real tap without advance intent. History is
Back, not a link click. Each completed sample asserts one document and one
session lookup across all four modes. API responses are private/no-store;
Playwright routing also disables HTTP cache. No network/CPU throttling.

Median milliseconds (baseline → final):

| Entry | Cold document | Cold after app bootstrap* | Touch | Back | Warm no-intent click |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/` | 2540 → 2324 | 1215 → 913 | 599 → 607 | 545 → 553 | 560 → 566 |
| `/nav-a` | 1854 → 1829 | 557 → 554 | 588 → 588 | 538 → 544 | 554 → 557 |
| `/branch` | 2172 → 2229 | 914 → 912 | 591 → 588 | 546 → 541 | 556 → 554 |
| `/branch/nav-a` | 1920 → 1929 | 536 → 562 | 593 → 591 | 535 → 544 | 562 → 557 |

*Bootstrap is approximated by the first installed-fonts API request emitted
when app providers mount. It separates the large document/JS startup interval
from the later request/render interval; it is not a precise JS evaluation
profile, LCP or paint metric. Bootstrap was 1222–1764 ms in baseline samples,
1248–1463 ms in final samples.

Raw cold samples, baseline → final:

- `/`: `[2592,2540,2437]` → `[2368,2324,2288]`
- `/nav-a`: `[1854,1902,1797]` → `[1805,1829,1891]`
- `/branch`: `[2172,2165,2282]` → `[2229,2212,2240]`
- `/branch/nav-a`: `[2300,1883,1920]` → `[1899,1935,1929]`

Homepage page requests began 658–666 ms after bootstrap before, versus
351–367 ms after. Explicit microsite branding started 347–368 ms after
bootstrap before, versus at bootstrap after. That removes a dependency, but
**does not establish a measurable first-content improvement for microsites
under this fixture**: the page/renderer path dominates. Likewise small
touch/warm/history differences here are noise, not speed claims. Do not
attribute the whole document-time delta to this patch.

The initial development-server timing run was rejected as comparison evidence:
module transformation/startup caused a timeout and inconsistent readiness.
The table uses only the matched production-mode builds, not that run or the
intermediate homepage implementation. Earlier built measurements used
assertion-polling completion timestamps; both builds were remeasured with the
same visibility-checked observer after correcting that measurement overhead.

### Public API timing and authority

The actual handler is tested with injected, in-memory page and viewer reads
of 200 ms each. A matched control forces viewer work to wait for page work;
the candidate leaves them independent. All six requests resolve a fresh viewer:

- Serial control: `[401,402,402]` ms.
- Parallel: `[201,201,201]` ms.

This demonstrates removal of one serial wait for page reads, including requests
from touch and history navigation. It is **not end-to-end production evidence**.
Both responses still wait for page and viewer, and symbol/element reads remain
page-scoped. Guest/member projection, tenant matching, private/no-store headers,
missing login pages and failures are covered by the API regressions.

### Verification

Final commands/results:

```sh
npx vite build --outDir /tmp/4984-candidate-build

node scripts/run-isolated-tests.mjs --shell "node --test api/public/page/loginResolution.test.mjs api/public/canvasMemberOnly.integration.test.mjs api/public/canvasSymbols.integration.test.mjs"

node scripts/run-isolated-tests.mjs --shell "node --import tsx --test client/src/components/navigation/publicPageIntent.test.mjs client/src/components/navigation/PublicPageNavigation.test.jsx client/src/contexts/RouteLayoutContext.test.jsx client/src/components/layouts/PortalReadiness.test.jsx client/src/pages/dynamicPageFirstLoad.test.mjs client/src/pages/dynamicPageRequest.test.mjs client/src/lib/publicHeaderNavigationActions.test.mjs client/src/lib/viewerProtectedWorkGate.test.mjs"

node scripts/run-isolated-tests.mjs node --import tsx --test client/src/pages/HomePageRedirect.test.jsx

node --test client/src/api/publicClient.relationshipDiscovery.test.mjs

PLAYWRIGHT_BASE_URL=http://127.0.0.1:5001 npx playwright test --config=client/src/components/navigation/publicPageNavigation.browser.config.mjs

PLAYWRIGHT_BASE_URL=http://127.0.0.1:5001 npx playwright test --config=tests/portal-session-boundaries.config.mjs
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 npx playwright test --config=tests/portal-session-boundaries.config.mjs --grep 'cold guest public actions'

PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(which chromium) npx playwright test --config=tests/dd-swap.config.mjs
node scripts/run-isolated-tests.mjs --shell "node --test api/due-diligence/swapExecuteRelationship.test.mjs"
git diff --check
```

- Build passed (existing large-chunk/mixed-import warnings).
- API: 30 passed. Navigation/session/homepage client units: 45 passed.
  The mounted homepage regression holds branding pending while discovery
  returns a valid slug, then fails branding. It verifies an explicit error,
  no page request, no content/chrome and a settled no-chrome layout decision.
  This caught a disabled-query pending-state bug introduced by early discovery;
  page pending is now counted only when its query is eligible.
- Relationship discovery: 6 passed with its explicitly local HTTP fixture.
  The initial guarded invocation blocked that fixture's localhost fetch; it was
  rerun separately after inspecting the test, not pointed at a real service.
- Website browser: 19 passed, including the four timing scenarios, held-session
  homepage, held-catalogue microsite, hidden chrome, explicit settings failure,
  intent adoption, logout fencing, and guest/member main/microsite navigation.
  After changing the timing observer only, all four timing scenarios passed
  again on both baseline and final builds.
- Session/sidebar: 19 passed on the built app; 11 retired polling tests skipped.
  One source-import test cannot run against static output (`/src/api/base44Client.js`);
  that exact test passed separately on the development server. No test was
  weakened to hide the mismatch.
- Due Diligence form-swap: 2 browser and 12 isolated server tests passed.
- Development workflow restarted successfully. Direct unmocked screenshot still
  shows the known `404: Tenant not found` against the existing development DB.
  No database was switched. Live signed-in UI, production latency, custom-domain
  deployment and real tenant content remain unverified.

To reproduce baseline timing, use an isolated checkout of the baseline
application revision with the current browser fixture only, build to a separate
directory, serve it on the same port, then run:

```sh
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5001 FIRST_CONTENT_PHASE=baseline \
  npx playwright test --config=client/src/components/navigation/publicPageNavigation.browser.config.mjs \
  --grep 'first-content critical path'
```

The phase variable labels results; it does not restore baseline code. Run phases
sequentially because website tests share their output directory. No deployment
or deployment identifier was created/obtained.

### Isolated rollback for this later correction

Exact changed file set:

- `api/public/page/[slug].js`
- `api/public/page/loginResolution.test.mjs`
- `client/src/pages/HomePageRedirect.jsx`
- `client/src/pages/HomePageRedirect.test.jsx` (new)
- `client/src/pages/DynamicPage.jsx`
- `client/src/contexts/MicrositeContext.jsx`
- `client/src/components/navigation/publicPageNavigation.browser.spec.mjs`
- `docs/website-navigation-rollback.md`
- `.agents/memory/MEMORY.md`
- `.agents/memory/website-critical-path.md` (new)

After the owner records the isolated merge/commit, inspect it and revert **only
this correction**, never the earlier intent correction or entire baseline:

```sh
git status --short
git show --stat <first-content-parallelism-commit>
git revert <first-content-parallelism-commit>
```

If mixed with unrelated work or conflicted, stop and prepare a reviewed
file-scoped reverse patch including the new memory file. Verify with
`git apply --reverse --check <reviewed-first-content.patch>` before applying.
This candidate's reverse-patch applicability was checked; no rollback applied.
There is no DB migration or DB rollback. Re-run navigation/session/form-swap
checks. Restoring this baseline preserves the absence of public skeletons/bars
and retains earlier session, intent and form-swap fixes.

Hosting recovery still requires separate approval and a verified prior deployment
reference. No hosting rollback was rehearsed. Production writes/deployment remain
outside this task.

## Revised baseline and scope

Correction baseline, captured with `git rev-parse HEAD` before implementation:
`81ba3cc7b19705425c7164bdddbd80a62de8ba88`. The working tree was clean.
This revision already contains the earlier website request handoff, session
display-continuity fix and Due Diligence changes. The original navigation work
started at `3ffed212d07a99853836f18606d5be24d905c2a2`; that older revision is not
the rollback target for this correction.

The user rejected the visible Loading/Cancel strip and public skeletons.
This correction removes those presentation elements and overlaps destination
requests with deliberate mouse hover or keyboard focus. No database changes,
migrations, campaign changes, production deployment, workflow restart or commit
were performed. No database rollback is necessary.

### Exact file list

Modified:

- `client/src/api/publicClient.js`
- `client/src/components/layouts/PublicLayout.jsx`
- `client/src/components/navigation/PublicPageNavigation.jsx`
- `client/src/components/navigation/PublicPageNavigation.test.jsx`
- `client/src/components/navigation/publicPageNavigation.browser.spec.mjs`
- `client/src/pages/DynamicPage.jsx`
- `client/src/pages/dynamicPageFirstLoad.test.mjs`
- `docs/website-navigation-rollback.md`

Added:

- `client/src/components/navigation/publicPageIntent.js`
- `client/src/components/navigation/publicPageIntent.test.mjs`

The existing browser config remains
`client/src/components/navigation/publicPageNavigation.browser.config.mjs`;
it is used but not modified by this correction. No Layout, router definition,
session policy, permission endpoint or server file is changed.

## Behaviour and safety boundaries

- Public navigation has no visible progress strip, Cancel control or skeleton.
  Pending announcements are screen-reader-only and take no layout space.
  Known portal loading/readiness components are unchanged.
- Mouse hover or keyboard focus sustained for 100 ms may start a request for
  an eligible same-origin DynamicPage destination. Touch hover, modified clicks,
  downloads, external/new-tab links, query/preview URLs and unmatched routes
  are not intercepted by this feature.
- Only the current intent target is eligible for adoption. At most two actual
  transports may await settlement; only the latest target may queue for a slot.
  Superseded/abandoned transports are aborted. Unactivated intent expires after
  five seconds. Actual activation retains the existing 20-second pending bound.
- A click adopts the matching **in-flight** request. Repeated activation shares
  that request. The current website and current URL stay in place until it
  settles; destination content then goes through the existing DynamicPage gates.
- Completed speculative responses are discarded, not cached for future clicks.
  If hover finishes before activation, activation performs a fresh read.
  Browser/server cache contracts are not extended; no protected fallback or
  cookie-bearing response pool is introduced.
- Tenant, audience, role/session and route changes fence or abort old work;
  relevant account-storage events fence it immediately. Prefix and slug must
  match exactly for adoption. No timer/focus auth polling was added.
- A destination-specific one-use transport may survive that destination's
  microsite-branding readiness transition. This avoids a duplicate cross-prefix
  read. It is not a chrome decision: DynamicPage still waits for destination
  metadata/audience prerequisites before projecting data or committing layout.
- Fresh public response policy overrides an older projected query result,
  including a newly hidden-chrome A page on A-B-A navigation.

## Controlled timing evidence

These are isolated browser fixture measurements, **not production timings,
document LCP or a claim that the server became faster**.

Each sample uses an API response delayed by 800 ms, with 600 ms of pointer dwell
before activation. All APIs are intercepted; responses use
`Cache-Control: private, no-store`. Three fresh-document samples were collected
per route scope. The metric starts immediately before programmatic activation
and ends two animation frames after the actual destination paragraph enters
the DOM. This measures click-to-real-content, not a loading-state paint.

The first baseline run was taken on the application code at the correction
baseline before intent handlers were implemented. The final matched control
uses the same candidate app and timing fixture, suppressing only delivery of
pointerover events to React; clicks, auth, metadata gates and rendering remain
unchanged. The normal candidate receives intent events. The final timing fixture
keeps the original baseline page markup and microsite catalogue.

| Route scope | Baseline revision, ms | Same-fixture no-intent control, ms | Final intent candidate, ms |
| --- | --- | --- | --- |
| Main site | 863, 852, 851 | 851, 847, 845 | 332, 324, 331 |
| Microsite `/branch` | 906, 840, 865 | 846, 860, 847 | 327, 333, 324 |

Matched-control median: 847 ms in both scopes. Candidate medians: 331 ms for the
main site and 327 ms for the microsite, reductions of 516 ms and 520 ms in
post-click wait under this specific fixture.
The request is started during intent dwell rather than after activation.
Every timing sample issued exactly one destination page request.

This benefit requires activation while intent work is still in flight. A click
without advance intent still waits for its request; a completed abandoned hover
does not authorize or speed a later click via retained application data.
Direct entry and browser history cannot prepare a request before activation and
may have a safe empty public content area while destination policy is unknown;
they do not show the removed public placeholders. This correction does not
promise continuous public chrome for unresolved history/direct destinations.

## Exact verification commands and results

### Before implementation

The timing harness was added first and run against baseline application code:

```sh
NAV_TIMING_PHASE=baseline npx playwright test \
  --config=client/src/components/navigation/publicPageNavigation.browser.config.mjs \
  --grep 'controlled intent timing'
```

Result: **2 passed**; baseline samples are in the table. That phase was captured
before editing application code; setting this label on the completed candidate
is not a substitute for checking out the reviewed baseline.

### Final unit and mounted regressions

```sh
node --import tsx --test \
  client/src/components/navigation/publicPageIntent.test.mjs \
  client/src/components/navigation/PublicPageNavigation.test.jsx \
  client/src/contexts/RouteLayoutContext.test.jsx \
  client/src/components/layouts/PortalReadiness.test.jsx \
  client/src/pages/dynamicPageFirstLoad.test.mjs \
  client/src/pages/dynamicPageRequest.test.mjs \
  client/src/lib/publicHeaderNavigationActions.test.mjs \
  client/src/lib/viewerProtectedWorkGate.test.mjs \
  client/src/api/publicClient.relationshipDiscovery.test.mjs
```

Result: **50 passed**. Coverage includes one-use handoff isolation, intent expiry,
hover/focus/click idempotence, delayed abort acknowledgement with a two-transport
ceiling, latest-target queuing, scope/prefix transitions, guest projection,
protected fallback failure boundaries and unchanged mounted portal readiness.

### Final website browser checks and matched timing control

```sh
NAV_TIMING_PHASE=control npx playwright test \
  --config=client/src/components/navigation/publicPageNavigation.browser.config.mjs \
  --grep 'controlled intent timing'

npx playwright test \
  --config=client/src/components/navigation/publicPageNavigation.browser.config.mjs
```

Results: **2 control tests passed** and **12 candidate tests passed**.
The suite uses `/tmp/public-page-navigation-results`; run its phases sequentially.
It verifies:

- guest/member main-site and microsite slow A-B-A, error and hidden destinations;
- no visible Loading/Cancel strip, no public skeleton, and unchanged actual header
  top/height while destination requests are held;
- screen-reader-only status dimensions; cold hidden destinations mount no chrome;
- keyboard preloading, double activation and one-request adoption;
- rapid target aborts and at-most-two actual page transports;
- same-slug cross-prefix requests do not reuse another site's payload;
- logout storage invalidation during member preloading and late-response fencing;
- newly hidden A policy beats cached projection, with zero excluded chrome
  insertions in mutation history;
- public draft DOM survives reconnect/focus events, without extra auth or document
  requests on normal navigation.

### Session and portal/sidebar browser checks

```sh
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 npx playwright test \
  --config=tests/portal-session-boundaries.config.mjs
```

Result on final application code: **20 passed; 11 intentionally retired polling
tests skipped**. Includes actual header/sidebar/toggle preservation on portal
history navigation, no session polling on focus/timers, authoritative rejection,
account/role changes, logout and guest/protected boundaries.
The explicit base URL aligns the sidebar fixture allowlist with the browser.
Its output directory is separate from website results.

```sh
git diff --check
```

Result: passed. All browser API writes were intercepted; the navigation-activity
fixture allowance did not write to a real database. Live signed-in tenant UI,
production speed, deployment identity and custom-domain behaviour were not
verified. Independent owner integration verification remains required.

Reverse-patch applicability also passed for the complete ten-file correction:
the tracked diff plus `git diff --no-index -- /dev/null <new-file>` for each of
the two added intent files was piped to `git apply --reverse --check`. No reverse
patch was applied; this is not a hosting rollback rehearsal.

## Review and rollback

Before release, review this exact file set and record the isolated correction
commit after the owner creates it. Record the prior working deployment URL/ID,
environment and source revision; no deployment reference was obtained here.
Verify the matching preview build and obtain separate production approval.

Rollback triggers include hangs, extra document navigations, unexpected header
movement, loss of established drafts, cross-tenant/audience/prefix consumption,
excluded chrome insertion, unbounded speculative work or any session-policy
regression.

For a committed isolated correction, inspect first, then revert only that
reviewed correction commit:

```sh
git status --short
git show --stat <intent-preloading-correction-commit>
git revert <intent-preloading-correction-commit>
```

Replace the placeholder with the reviewed correction commit, not either baseline
revision. If several isolated correction commits exist, revert newest first.
If unrelated work is included or a revert conflicts, stop and prepare a reviewed
file-scoped reverse patch instead. Do not use `git reset --hard`, restore the
whole older baseline, select a merge mainline blindly or restore a database.

For an uncommitted candidate, preserve the diff and new files before preparing
and reviewing a reverse patch for the exact list above. Check applicability
with `git apply --reverse --check <reviewed-correction.patch>` before applying;
that patch must include both newly added intent-pool files, not just tracked
file diffs. No source rollback was applied as part of this implementation.

Re-run relevant verification after rollback. Intent-specific tests must match
the restored code: the baseline intentionally does not implement intent
preloading. A rollback of this correction restores the baseline's rejected
visible Loading/Cancel strip and public skeleton, so it is an emergency recovery
step, not the desired final presentation. Earlier session and form-swap fixes
must remain.

For deployed recovery, the owner may restore the recorded prior deployment
only after confirming environment/source and considering unrelated changes in
that deployment. Prefer an isolated source revert when rolling back a whole
deployment would lose unrelated fixes. No hosting rollback was performed.
Verify the served build, main-site/microsite links, header-free page, member/guest
boundaries and external/download/modifier semantics after recovery.

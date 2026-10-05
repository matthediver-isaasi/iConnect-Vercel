# Website navigation intent-preloading correction — verification and rollback

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

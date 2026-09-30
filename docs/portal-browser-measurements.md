# Task 4596: controlled portal browser checks

## Scope and reproducibility

The Playwright suite in `tests/portal-loading.spec.mjs` visits the actual application
at `/portal` with a published hybrid Canvas page and a validated member fixture.
It exercises the real router, DynamicPage, Layout, providers, role hook and Canvas
renderer, not an isolated rendering harness. API responses are intercepted:
critical requests receive a fixed 200 ms delay, other optional reads receive empty
responses, and mutations are rejected. This does not verify a real tenant's API,
branding, permissions configuration, database or production network.

The initial original HEAD checkout was served by standalone development Vite on port
5173; the changed checkout was served by Express with Vite middleware on port
5000. Both used NODE_ENV=development, the same Chromium executable, viewport,
fixture and test. Their server topology differs. No CPU/network throttling was
applied. API interception disables Playwright's HTTP cache: “warm” below means a
reload in the same browser context, **not** a browser HTTP-cache benchmark.
Storage is cleared on each document load. “Internal” uses history.pushState and
a popstate event to trigger client routing to `/portal-next`, without loading a
new document. It does not exercise a particular menu click.

Run:

```sh
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5173 PORTAL_MEASUREMENT_LABEL=baseline npx playwright test --config=tests/portal-loading.config.mjs --grep 'controlled portal'
PORTAL_MEASUREMENT_LABEL=after npx playwright test --config=tests/portal-loading.config.mjs
```

Each run writes request start/completion offsets and content visibility timing
to `/tmp/portal-loading-LABEL.json`, attaches it to the test result, and captures
`/tmp/portal-loading-LABEL.png`. Test traces have an isolated output directory.
The heading visibility check includes ancestor visibility; the final screenshot
shows the real member sidebar and rendered Canvas content.

## Observations (milliseconds)

These are single-run observations, not statistical estimates:

### Matched standalone-server comparison (preferred)

After the initial observations below, port 5173 was switched from original HEAD
to the changed checkout using the same standalone Vite command and
NODE_ENV=development. The changed server was primed with one complete timing
test, then measured with a second test in a fresh browser context, matching the
original `baseline-repeat` sequence. API delays, executable, viewport, storage
reset, disabled HTTP caching and navigation method were unchanged.

| Warmed standalone server, fresh context | Original HEAD | Changed checkout |
| --- | ---: | ---: |
| New-context visit, content visible | 5,418 | 4,398 |
| Same-context reload, content visible | 5,079 | 4,428 |
| Internal navigation, content visible | 1,474 | 1,443 |

This removes the Express-versus-standalone topology confound from the preferred
comparison. It remains a single pair of development-server samples, not a
production benchmark. Internal navigation changed by only 31 ms in this pair;
these observations do **not** establish a substantial navigation improvement.
The changed server's priming visit took 38,779 ms and is excluded, just as the
original unprimed visit is excluded.

A 16 ms DOM sampler additionally recorded the first sidebar with layout bounds
and no hidden/display-none/zero-opacity ancestors on the changed checkout:
4,311 ms for the new-context document and 4,391 ms for the reload, measured from
browser navigation start. These are shell-visibility observations, separate
from the heading-visibility timings measured by the test runner. The original
baseline did not have this sampler, so **no before/after shell timing claim** is
made. Internal navigation retains the document; the document-first-shell
sampler is intentionally reported as null for that step.

The matched changed visit began its first public-page request at 3,135 ms,
auth at 3,139 ms, visibility at 3,141 ms and branding at 3,148 ms. Initial content
became visible 1,263 ms after the first page request began, versus 1,402 ms in
the original repeat. Four initial and five internal public-page reads persisted.
Matched reports are `/tmp/portal-loading-after-matched{,-prime}.json`.

### Earlier unmatched observations (retained for transparency)

| Run | Original HEAD | Changed checkout |
| --- | ---: | ---: |
| First recorded new-context visit | 38,331 | 5,332 |
| Same-context reload | 4,619 | 4,825 |
| Internal navigation | 1,480 | 1,253 |
| Repeat run, new-context visit | 5,418 | 4,244 |
| Repeat run, same-context reload | 5,079 | 4,121 |
| Repeat run, internal navigation | 1,474 | 1,102 |

The original first visit includes an unprimed Vite dependency/transform startup
and is **not a defensible before/after speedup comparison**. Repeat observations
with already-warmed development servers were faster on the changed checkout,
but the small sample, differing server topology and development compilation make
these insufficient to claim a production percentage improvement.

In repeat cold-context runs, the initial public page request began at 4,016 ms
before versus 2,939 ms after. Auth began at 4,018 versus 2,940 ms; branding at
4,021 versus 2,947 ms. These transports overlap in both revisions. Content became
visible 1,402 ms versus 1,305 ms after the first page request began.

**Remaining observation:** both revisions made four public-page reads before
initial content visibility and five on internal navigation in this fixture.
Role lookup occurred once per measured navigation, and auth occurred once.
The task does not eliminate repeated dynamic-page reads/remounts; those requests
remain visible in the raw timing attachments. These counts are fixture evidence,
not a claim that every production route behaves this way.

## Regression results

All 12 changed-checkout browser tests passed:

- Initial visit, reload and internal navigation reach visible page content.
- Individually held auth, branding, page, role and visibility requests prevent
  premature content display; releasing each request allows the page to appear.
- Failed branding, page, role and visibility requests keep page content closed
  and display a visible alert.
- A confirmed guest can view the hybrid page without a member sidebar.
- A failed authentication response does not display the member sidebar.

These tests do not cover authenticated production sessions, real restrictive
role matrices, account switching or full logout sequences. They supplement,
rather than replace, existing session/role regression suites. The separate
`portal-route-bundle-measurements.md` records production **bundle size**, not
browser performance.
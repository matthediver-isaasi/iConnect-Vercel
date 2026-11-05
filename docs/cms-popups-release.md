# CMS Canvas Popups — Phase 1 release boundaries

## Delay diagnostics

Reviewed read-only Canvas list/group skeletons and gallery refreshes no longer
block a page-ready popup. Their `aria-busy` accessibility indicators remain.
Homepage, embedded-form and unknown busy elements still block; payment, booking,
consent and competing-dialog protections take precedence over background labels.
`interference_changed` reports a controlled blocker category
(`homepage_loading`, `membership_loading`, `embedded_form_loading`,
`unclassified_busy`, `dialog`, `critical_flow`, or `clear`) without DOM text or IDs.
Delivery requests use the existing within-request session reuse option; each
subsequent content, eligibility or preference request authenticates afresh.
Live latency improvement must be measured after deployment, not inferred from
isolated tests.

After deploying the matching client and API, reproduce the delay on a fresh page
visit (navigate away and follow a link back, rather than refreshing a consumed
history entry). In the browser Console run:

```js
window.iconnectPopupDiagnostics()
```

This returns JSON text directly, not `console.table()`'s `undefined` return.
It holds the latest 250 events in memory for the current document. A hard reload
clears the trace. Optionally add `?popupDebug=1` (or `&popupDebug=1` when a query
already exists) to stream the same events under `[CMS popup]` in Console.
Diagnostics do not clear dismissals or change any delivery safeguards.

The trace records:

- Homepage prerequisite/loading stages and popup runtime mount/unmount.
- Early discovery reuse or rejection, including its age and expiry reason.
- Eligibility, selected content, periodic content rechecks and preference writes
  as distinct request kinds, with HTTP status and request duration.
- Refresh causes: initial load, interval, browser focus and visibility changes.
- Waiting reasons such as consent, another dialog, page busy, payment/booking
  flow, an active editable field, trigger timing, frequency/dismissal restrictions
  and an already-consumed page visit. Repeated identical waits are deduplicated.
- Discarded content responses and why they could not be displayed.
- Opening requested (`popup_opened`), actual modal container attachment
  (`modal_content_mounted`), and subsequent closure. Container attachment is not
  proof that all images inside the Canvas content have finished loading.

`atMs` is milliseconds since document navigation. `durationMs` is the request
duration. `serverMs` comes from the API's `Server-Timing` response header and
separates tenant/session resolution, page lookup, candidate scan, field discovery,
audience loading, preferences, design resolution and preference writes. Parallel
stage durations overlap; do not add them to estimate the total.
The server `total` starts when the popup handler is entered. It excludes network,
platform cold-start, module-loading and middleware work before that point; a large
gap between request duration and server total is not automatically database time.

Only controlled reason codes, counts, local diagnostic sequence numbers, statuses
and durations are recorded. No member names/IDs, tenant IDs, URLs, tokens, popup
content, audience answers or raw error/response bodies are retained. The trace is
not stored in browser storage, sent to analytics or uploaded automatically.
Existing no-store response headers and authorisation rules remain in force.

## Storage and deployment

`supabase/migrations/202611050001_cms_popups.sql` was applied to verified live
DEST on 5 November 2026 with owner approval. It adds service-only definitions,
page links, preferences and two transactional RPCs. Disposable PostgreSQL tests
passed before application; live RLS and browser/server grants were verified
afterwards. The list and discovery handlers returned HTTP 200 against DEST.
For any other environment, obtain schema approval before applying it and release
it before the matching application. Never apply it to workspace SOURCE.
Source merge is not evidence of public rollout. No popup content is published
automatically by this change.

No browser role has direct grants to the popup tables or RPCs. Dedicated
`site-builder.popups` and `site-builder.popup-editor` permissions protect the API.
Page-editor permission alone is insufficient. Page scope is immutable to preserve
microsite typography meaning. Duplicate creates a draft with no visitor state;
restore returns to draft. Reset advances the separate dismissal generation.
Ordinary edits and archive preserve preferences. Save and link replacement are
one transaction with expected revision checks.

## Eligibility contract

Delivery resolves the host tenant, current session and published page independently.
The page ID and microsite ID must agree. Member pages require a member, not only
a tenant-user session. Responses are private/no-store. The batch contains no
design or targeting clauses; only the selected, freshly authorized document and
its referenced, tenant-owned symbols are returned.

One request evaluates at most 100 scoped active definitions. Larger or incomplete
sets fail closed; they are not silently truncated. Metadata and viewer-affiliation
reads have explicit completeness checks and limits. No campaign-recipient
enumeration is used. Unsupported/deleted conditions invalidate eligibility.
All organisation clauses in an AND group match the same real affiliation.
Secondary assignments use the configured profile-affiliation relationship pair;
department ownership does not create affiliation.

Membership status/type reuse the existing Canvas commitment selector and summary,
including retained history and amendment/recognition overlays. Membership class
and organisation type/category are exposed through active typed tenant custom
fields where defined; they are not invented as universal database columns.

Supported Canvas content is the explicit list in `shared/cmsPopupContract.js`.
Both design versions use the existing renderer. Nested symbols and unsupported
blocks fail explicitly. Symbols are resolved at save/preview/delivery; missing
symbols never authorize a fallback catalogue as popup content.

Schedule input is converted from tenant wall time into explicit UTC timestamps.
Ambiguous/nonexistent DST times are rejected. The saved lifecycle is independent
of schedule availability. Calendar-day frequency uses tenant timezone; N days
uses elapsed 24-hour intervals.

## Visitor persistence and interference

See `client/src/components/popups/README.md` for history-entry identity, storage
keys, consent and accessibility. Permanent member preferences are monotonic,
server-backed and generation-scoped. Impression retries use the original
`shown_at` and a monotonic maximum, so retrying cannot advance frequency time.
Ordinary open revalidation retains the mounted interactive document.

Foreground revalidation runs every 30 seconds with 10-second request deadlines
(at most 50 seconds for both checks). Background browser suspension prevents a
hard wall-clock guarantee; focus/visibility return rechecks and scheduled end is
also checked locally. This is not instantaneous revocation.

## Verification evidence

Run isolated API/evaluator/mounted checks:

```
node scripts/run-isolated-tests.mjs node --test \
  api/cms-popups/popups.test.mjs shared/cmsPopupContract.test.mjs \
  client/src/lib/popupRuntimeState.test.mjs \
  client/src/components/popups/*.test.mjs
```

Run disposable PostgreSQL checks:

```
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  supabase/migrations/cmsPopups.test.mjs
```

Real-browser fixture suite (existing application workflow must be running):

```
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(command -v chromium)" \
  npx playwright test --config=client/src/components/popups/browser/playwright.config.mjs
```

Browser fixtures intercept API calls and block external origins. They exercise
actual Radix/Canvas rendering, responsive layouts, keyboard/focus, overflow,
priority, navigation/history, consent and storage denial. They are **not**
authenticated tenant evidence, a live cross-device check, or production rollout
evidence. Disposable PostgreSQL verifies permissions/ownership, revision
conflicts, reset generations, duplicate state isolation and foreign-key cleanup.
